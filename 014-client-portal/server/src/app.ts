import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { loadConfig, type AppConfig } from './config.js';
import { openDb } from './db.js';
import { createStorage } from './storage/index.js';
import { createMailer } from './mail.js';
import type { Ctx } from './context.js';
import { HttpError } from './util.js';
import { authRoutes } from './routes/auth.js';
import { clientRoutes } from './routes/app-clients.js';
import { projectRoutes } from './routes/app-projects.js';
import { deliverableRoutes } from './routes/app-deliverables.js';
import { deliveryRoutes } from './routes/app-deliveries.js';
import { miscRoutes } from './routes/app-misc.js';
import { portalRoutes } from './routes/portal.js';
import { fileRoutes } from './routes/files.js';
import { selectionRoutes } from './routes/selections.js';
import { correctionRoutes } from './routes/corrections.js';
import { startJobs } from './jobs.js';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: Ctx;
  }
}

export const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ');

/** URL中の秘密情報をログに出さない */
function redactUrl(url: string): string {
  return url.replace(/([?&](token|t|m|key)=)[^&]+/gi, '$1[REDACTED]');
}

export interface BuildOptions {
  config?: Partial<AppConfig>;
  startJobs?: boolean;
  /** テスト用: ログ出力先 */
  logStream?: NodeJS.WritableStream;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const cfg = loadConfig(opts.config ?? {});
  const db = openDb(cfg.dbPath);
  const storage = createStorage(cfg);
  const mailer = createMailer(cfg);

  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      serializers: {
        req(req: FastifyRequest) {
          return { method: req.method, url: redactUrl(req.url), remoteAddress: req.ip };
        },
      },
      ...(opts.logStream ? { stream: opts.logStream } : {}),
    },
    trustProxy: cfg.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  const ctx: Ctx = { cfg, db, storage, mailer, log: app.log };
  app.decorate('ctx', ctx);

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    // テスト・E2E用。本番（NODE_ENV=production）では無効化できない
    allowList: cfg.env === 'test' || (cfg.env !== 'production' && process.env.DISABLE_RATE_LIMIT === 'true') ? () => true : undefined,
  });

  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  // セキュリティヘッダ
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (cfg.publicUrl.startsWith('https://')) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (!reply.getHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', SPA_CSP);
    if (req.url.startsWith('/api/') && !reply.getHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // CSRF対策: 状態変更リクエストはカスタムヘッダ必須 + Origin 検証
  const allowedOrigin = new URL(cfg.publicUrl).origin;
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.headers['x-cp-csrf'] !== '1') throw new HttpError(403, 'csrf', '不正なリクエストです（CSRF）');
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) {
      const hostOrigin = `${req.protocol}://${req.headers.host}`;
      if (origin !== hostOrigin) throw new HttpError(403, 'csrf', '不正なリクエスト元です');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, ...err.extra });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation',
        message: '入力内容を確認してください',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode === 429) return reply.status(429).send({ error: 'rate_limited', message: 'リクエストが多すぎます。しばらく待ってから再度お試しください' });
    if (e.statusCode === 413 || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({ error: 'too_large', message: 'データが大きすぎます' });
    }
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: 'bad_request', message: e.message });
    req.log.error({ err: { message: e.message, code: e.code } }, 'unhandled error');
    return reply.status(500).send({ error: 'internal', message: 'サーバーでエラーが発生しました。時間をおいて再度お試しください' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(clientRoutes);
  await app.register(projectRoutes);
  await app.register(deliverableRoutes);
  await app.register(deliveryRoutes);
  await app.register(miscRoutes);
  await app.register(portalRoutes);
  await app.register(fileRoutes);
  await app.register(selectionRoutes);
  await app.register(correctionRoutes);

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found', message: '見つかりません' });
    const index = path.join(cfg.webDist, 'index.html');
    if (req.method === 'GET' && fs.existsSync(index)) {
      reply.header('Cache-Control', 'no-cache');
      return reply.type('text/html; charset=utf-8').send(fs.readFileSync(index));
    }
    return reply.status(404).send('Not found');
  });

  if (fs.existsSync(cfg.webDist)) {
    await app.register(fastifyStatic, {
      root: cfg.webDist,
      prefix: '/',
      wildcard: false,
      index: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else res.header('Cache-Control', 'no-cache');
        if (filePath.endsWith('sw.js')) res.header('Service-Worker-Allowed', '/');
      },
    });
    app.get('/', (_req, reply) => {
      reply.header('Cache-Control', 'no-cache');
      return reply.type('text/html; charset=utf-8').send(fs.readFileSync(path.join(cfg.webDist, 'index.html')));
    });
  }

  let stopJobs: (() => void) | null = null;
  if (opts.startJobs) stopJobs = startJobs(ctx);
  app.addHook('onClose', async () => {
    stopJobs?.();
    db.close();
  });

  return app;
}

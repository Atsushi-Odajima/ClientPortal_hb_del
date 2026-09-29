import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CLIENT_COOKIE,
  OPERATOR_COOKIE,
  clearCookie,
  createClientSession,
  createOperatorSession,
  dummyVerify,
  hashPassword,
  requireClient,
  requireOperator,
  validatePassword,
  verifyPassword,
} from '../auth.js';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { HttpError, addMinutes, badRequest, hashIp, newId, newToken, nowIso, sha256Hex, shortUa, timingSafeEqualStr } from '../util.js';
import { clientProjects } from '../access.js';

export const emailSchema = z.string().trim().toLowerCase().email('メールアドレスの形式が正しくありません').max(254);

const signupSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1, '氏名を入力してください').max(100),
  businessName: z.string().trim().max(100).default(''),
  password: z.string(),
  setupToken: z.string().optional(),
});

export function reqMeta(ctx: Ctx, req: FastifyRequest) {
  return { ipHash: hashIp(ctx.cfg.sessionSecret, req.ip), userAgent: shortUa(req.headers['user-agent']) };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

interface InviteLookup {
  invite_id: string;
  kind: 'invite' | 'magic';
  expires_at: string;
  revoked_at: string | null;
  max_uses: number | null;
  use_count: number;
  failed_attempts: number;
  access_id: string;
  access_status: string;
  project_id: string;
  project_name: string;
  portal_status: string;
  archived_at: string | null;
  owner_id: string;
  business_name: string;
  operator_name: string;
  client_id: string;
  client_email: string;
  client_company: string;
  client_contact: string;
  client_status: string;
}

function lookupInvite(ctx: Ctx, token: string): InviteLookup | null {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const hash = sha256Hex(token);
  const row = ctx.db
    .prepare(
      `SELECT i.id invite_id, i.kind, i.expires_at, i.revoked_at, i.max_uses, i.use_count, i.failed_attempts, i.token_hash,
              pa.id access_id, pa.status access_status,
              p.id project_id, p.name project_name, p.portal_status, p.archived_at, p.owner_id,
              o.business_name, o.name operator_name,
              c.id client_id, c.email client_email, c.company_name client_company, c.contact_name client_contact, c.status client_status
       FROM invites i
       JOIN portal_access pa ON pa.id = i.access_id
       JOIN projects p ON p.id = pa.project_id
       JOIN operators o ON o.id = p.owner_id
       JOIN clients c ON c.id = pa.client_id
       WHERE i.token_hash = ?`,
    )
    .get(hash) as (InviteLookup & { token_hash: string }) | undefined;
  if (!row || !timingSafeEqualStr(row.token_hash, hash)) return null;
  return row;
}

function inviteProblem(inv: InviteLookup | null): string | null {
  if (!inv) return 'invalid';
  if (inv.revoked_at) return 'revoked';
  if (Date.parse(inv.expires_at) < Date.now()) return 'expired';
  if (inv.max_uses !== null && inv.use_count >= inv.max_uses) return 'used';
  if (inv.access_status !== 'active' || inv.client_status !== 'active') return 'revoked';
  if (inv.portal_status !== 'published' || inv.archived_at) return 'closed';
  return null;
}

const INVITE_MESSAGES: Record<string, string> = {
  invalid: 'このリンクは無効です。担当者に新しい招待リンクの発行を依頼してください',
  revoked: 'このリンクは無効化されています。担当者にお問い合わせください',
  expired: 'このリンクは有効期限が切れています。担当者に再発行を依頼してください',
  used: 'このリンクは使用済みです。もう一度ログイン用リンクを請求してください',
  closed: 'この案件のポータルは現在公開されていません',
};

export async function authRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db, cfg } = ctx;

  app.get('/api/auth/state', async () => {
    const count = (db.prepare('SELECT COUNT(*) n FROM operators').get() as { n: number }).n;
    return {
      hasOperators: count > 0,
      allowSignup: cfg.allowSignup,
      setupRequiresToken: cfg.setupToken !== '',
      mailEnabled: ctx.mailer.enabled,
    };
  });

  async function createOperator(body: z.infer<typeof signupSchema>) {
    const pwErr = validatePassword(body.password);
    if (pwErr) throw badRequest(pwErr, 'weak_password');
    const exists = db.prepare('SELECT 1 FROM operators WHERE email = ?').get(body.email);
    if (exists) throw badRequest('このメールアドレスは登録済みです', 'email_taken');
    const id = newId('op');
    const now = nowIso();
    db.prepare(
      'INSERT INTO operators (id, email, name, business_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, body.email, body.name, body.businessName, await hashPassword(body.password, cfg.passwordScryptN), now, now);
    return id;
  }

  app.post('/api/auth/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = signupSchema.parse(req.body);
    const count = (db.prepare('SELECT COUNT(*) n FROM operators').get() as { n: number }).n;
    if (count > 0) throw new HttpError(403, 'setup_done', '初期設定は完了しています');
    if (cfg.setupToken && !timingSafeEqualStr(body.setupToken ?? '', cfg.setupToken)) {
      throw new HttpError(403, 'bad_setup_token', 'セットアップ用トークンが正しくありません');
    }
    const id = await createOperator(body);
    audit(db, { ownerId: id, actor: { type: 'operator', id, name: body.name }, action: 'operator.setup', ...reqMeta(ctx, req) });
    createOperatorSession(ctx, reply, id, shortUa(req.headers['user-agent']));
    return { ok: true };
  });

  app.post('/api/auth/signup', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (!cfg.allowSignup) throw new HttpError(403, 'signup_disabled', '新規登録は受け付けていません');
    const body = signupSchema.parse(req.body);
    const id = await createOperator(body);
    audit(db, { ownerId: id, actor: { type: 'operator', id, name: body.name }, action: 'operator.signup', ...reqMeta(ctx, req) });
    createOperatorSession(ctx, reply, id, shortUa(req.headers['user-agent']));
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ email: emailSchema, password: z.string().max(200) }).parse(req.body);
    const op = db.prepare('SELECT id, name, password_hash, status FROM operators WHERE email = ?').get(body.email) as
      | { id: string; name: string; password_hash: string; status: string }
      | undefined;
    if (!op) {
      await dummyVerify(cfg.passwordScryptN);
      throw new HttpError(401, 'bad_credentials', 'メールアドレスまたはパスワードが正しくありません');
    }
    const ok = await verifyPassword(body.password, op.password_hash);
    if (!ok || op.status !== 'active') {
      audit(db, { ownerId: op.id, actor: { type: 'anonymous', id: '-', name: '' }, action: 'operator.login_failed', ...reqMeta(ctx, req) });
      throw new HttpError(401, 'bad_credentials', 'メールアドレスまたはパスワードが正しくありません');
    }
    createOperatorSession(ctx, reply, op.id, shortUa(req.headers['user-agent']));
    audit(db, { ownerId: op.id, actor: { type: 'operator', id: op.id, name: op.name }, action: 'operator.login', ...reqMeta(ctx, req) });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[OPERATOR_COOKIE];
    if (token) db.prepare('DELETE FROM operator_sessions WHERE id_hash = ?').run(sha256Hex(token));
    clearCookie(ctx, reply, OPERATOR_COOKIE);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const op = requireOperator(ctx, req);
    return { operator: op, mailEnabled: ctx.mailer.enabled, limits: cfg.limits };
  });

  app.patch('/api/auth/me', async (req) => {
    const op = requireOperator(ctx, req);
    const body = z
      .object({ name: z.string().trim().min(1).max(100).optional(), businessName: z.string().trim().max(100).optional() })
      .parse(req.body);
    db.prepare('UPDATE operators SET name = COALESCE(?, name), business_name = COALESCE(?, business_name), updated_at = ? WHERE id = ?').run(
      body.name ?? null,
      body.businessName ?? null,
      nowIso(),
      op.id,
    );
    return { ok: true };
  });

  app.post('/api/auth/password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const op = requireOperator(ctx, req);
    const body = z.object({ current: z.string().max(200), next: z.string() }).parse(req.body);
    const row = db.prepare('SELECT password_hash FROM operators WHERE id = ?').get(op.id) as { password_hash: string };
    if (!(await verifyPassword(body.current, row.password_hash))) throw badRequest('現在のパスワードが正しくありません', 'bad_credentials');
    const err = validatePassword(body.next);
    if (err) throw badRequest(err, 'weak_password');
    db.prepare('UPDATE operators SET password_hash = ?, updated_at = ? WHERE id = ?').run(await hashPassword(body.next, cfg.passwordScryptN), nowIso(), op.id);
    db.prepare('DELETE FROM operator_sessions WHERE operator_id = ?').run(op.id);
    createOperatorSession(ctx, reply, op.id, shortUa(req.headers['user-agent']));
    audit(db, { ownerId: op.id, actor: { type: 'operator', id: op.id, name: op.name }, action: 'operator.password_changed', ...reqMeta(ctx, req) });
    return { ok: true };
  });

  // ---- 顧客: 招待リンク ----

  const inviteLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.post('/api/invite/inspect', inviteLimit, async (req) => {
    const { token } = z.object({ token: z.string().max(100) }).parse(req.body);
    const inv = lookupInvite(ctx, token);
    const problem = inviteProblem(inv);
    if (problem || !inv) return { valid: false, reason: problem, message: INVITE_MESSAGES[problem ?? 'invalid'] };
    return {
      valid: true,
      kind: inv.kind,
      projectName: inv.project_name,
      providerName: inv.business_name || inv.operator_name,
      clientCompany: inv.client_company,
      emailHint: maskEmail(inv.client_email),
      expiresAt: inv.expires_at,
    };
  });

  app.post('/api/invite/redeem', inviteLimit, async (req, reply) => {
    const body = z.object({ token: z.string().max(100), email: z.string().trim().toLowerCase().max(254).optional() }).parse(req.body);
    const inv = lookupInvite(ctx, body.token);
    const problem = inviteProblem(inv);
    if (problem || !inv) throw new HttpError(400, `invite_${problem}`, INVITE_MESSAGES[problem ?? 'invalid']);
    const meta = reqMeta(ctx, req);
    if (inv.kind === 'invite') {
      // 招待リンク単体の漏えい対策として、登録メールアドレスの入力を求める
      if (!body.email || body.email !== inv.client_email.toLowerCase()) {
        const failed = inv.failed_attempts + 1;
        db.prepare('UPDATE invites SET failed_attempts = ?, revoked_at = CASE WHEN ? >= 5 THEN ? ELSE revoked_at END WHERE id = ?').run(
          failed,
          failed,
          nowIso(),
          inv.invite_id,
        );
        audit(db, {
          ownerId: inv.owner_id,
          projectId: inv.project_id,
          actor: { type: 'anonymous', id: '-', name: '' },
          action: failed >= 5 ? 'invite.locked' : 'invite.email_mismatch',
          targetType: 'invite',
          targetId: inv.invite_id,
          ...meta,
        });
        if (failed >= 5) throw new HttpError(400, 'invite_locked', '確認に複数回失敗したため、このリンクは無効化されました。担当者に再発行を依頼してください');
        throw new HttpError(400, 'email_mismatch', 'メールアドレスが招待先と一致しません');
      }
    }
    const used = db
      .prepare(
        `UPDATE invites SET use_count = use_count + 1, last_used_at = ?, failed_attempts = 0
         WHERE id = ? AND revoked_at IS NULL AND (max_uses IS NULL OR use_count < max_uses)`,
      )
      .run(nowIso(), inv.invite_id);
    if (used.changes === 0) throw new HttpError(400, 'invite_used', INVITE_MESSAGES.used);
    createClientSession(ctx, reply, inv.client_id, inv.invite_id, meta.userAgent);
    audit(db, {
      ownerId: inv.owner_id,
      projectId: inv.project_id,
      actor: { type: 'client', id: inv.client_id, name: inv.client_contact || inv.client_company },
      action: inv.kind === 'magic' ? 'client.magic_login' : 'invite.redeemed',
      targetType: 'invite',
      targetId: inv.invite_id,
      summary: 'ポータルにアクセスしました',
      ...meta,
    });
    return { ok: true, projectId: inv.project_id };
  });

  // 再ログイン用マジックリンク（メール送信が有効な場合のみ）。存在有無を返さない
  app.post('/api/portal/magic-link', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    const generic = { ok: true, message: 'ご登録のメールアドレスであれば、ログイン用リンクを送信しました。メールをご確認ください' };
    if (!ctx.mailer.enabled) {
      return { ok: false, message: 'メール送信が設定されていません。担当者に招待リンクの再発行を依頼してください' };
    }
    const rows = db
      .prepare(
        `SELECT pa.id access_id, c.id client_id, c.owner_id, p.id project_id FROM clients c
         JOIN portal_access pa ON pa.client_id = c.id AND pa.status = 'active'
         JOIN projects p ON p.id = pa.project_id AND p.portal_status = 'published' AND p.archived_at IS NULL
         WHERE c.email = ? AND c.status = 'active'
         ORDER BY p.updated_at DESC`,
      )
      .all(email) as { access_id: string; client_id: string; owner_id: string; project_id: string }[];
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.client_id)) continue;
      seen.add(r.client_id);
      const token = newToken();
      const invId = newId('inv');
      db.prepare(
        `INSERT INTO invites (id, access_id, kind, token_hash, expires_at, max_uses, created_by, created_at) VALUES (?, ?, 'magic', ?, ?, 1, 'system', ?)`,
      ).run(invId, r.access_id, sha256Hex(token), addMinutes(new Date(), cfg.invite.magicLinkMinutes).toISOString(), nowIso());
      ctx.mailer.enqueue(db, {
        to: email,
        subject: '[Client Portal] ログイン用リンク',
        text: `以下のリンクから${cfg.invite.magicLinkMinutes}分以内にログインしてください（1回のみ有効）。\n\n${cfg.publicUrl}/invite#m=${token}\n\nお心当たりがない場合はこのメールを破棄してください。`,
      });
      audit(db, {
        ownerId: r.owner_id,
        projectId: r.project_id,
        actor: { type: 'anonymous', id: '-', name: '' },
        action: 'client.magic_link_requested',
        targetType: 'client',
        targetId: r.client_id,
        ...reqMeta(ctx, req),
      });
    }
    void ctx.mailer.flush(db).catch(() => undefined);
    return generic;
  });

  app.get('/api/portal/me', async (req) => {
    const c = requireClient(ctx, req);
    const op = db.prepare('SELECT name, business_name FROM operators WHERE id = ?').get(c.owner_id) as { name: string; business_name: string };
    const projects = clientProjects(db, c).map((p) => ({ id: p.id, name: p.name }));
    return {
      client: { id: c.id, companyName: c.company_name, contactName: c.contact_name, email: c.email },
      providerName: op.business_name || op.name,
      projects,
    };
  });

  app.post('/api/portal/logout', async (req, reply) => {
    const token = req.cookies[CLIENT_COOKIE];
    if (token) db.prepare('DELETE FROM client_sessions WHERE id_hash = ?').run(sha256Hex(token));
    clearCookie(ctx, reply, CLIENT_COOKIE);
    return { ok: true };
  });
}

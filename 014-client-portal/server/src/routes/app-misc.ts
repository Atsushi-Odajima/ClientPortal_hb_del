import type { FastifyInstance } from 'fastify';
import { ZipArchive } from 'archiver';
import { z } from 'zod';
import { requireOperator } from '../auth.js';
import { audit, verifyAuditChain } from '../audit.js';
import type { FileRow } from '../context.js';
import { conflict, contentDisposition, newId, notFound, nowIso, parseJsonArray, safeFileName } from '../util.js';
import { reqMeta } from './auth.js';
import { opActor, requestBody } from './app-projects.js';
import { createSampleProject, deleteSampleData } from '../services/sample.js';
import { APP_VERSION, SCHEMA_VERSION } from '../config.js';

const templateBody = z.object({
  name: z.string().trim().min(1, 'テンプレート名を入力してください').max(100),
  description: z.string().max(2000).default(''),
  clientGuidance: z.string().max(5000).default(''),
  requests: z.array(requestBody).max(50).default([]),
  categories: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  checklist: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
});

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  client_guidance: string;
  requests_json: string;
  categories_json: string;
  checklist_json: string;
  created_at: string;
  updated_at: string;
}

function templateDto(t: TemplateRow) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    clientGuidance: t.client_guidance,
    requests: parseJsonArray(t.requests_json),
    categories: parseJsonArray<string>(t.categories_json),
    checklist: parseJsonArray<string>(t.checklist_json),
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

/** 初回ログイン時に用意する標準テンプレート */
export const DEFAULT_TEMPLATES: z.input<typeof templateBody>[] = [
  {
    name: 'SNS運用開始',
    description: 'SNSアカウント運用を始める際の素材回収と投稿画像の確認',
    clientGuidance: '運用開始に必要な素材をご提出ください。投稿画像はポータルでご確認・ご承認いただけます。',
    requests: [
      { title: 'ロゴデータ', description: 'AI/PNG/SVGなど、お持ちの形式で', kind: 'file', required: true },
      { title: 'アカウント運用の目的', description: '認知拡大・集客など', kind: 'text', required: true },
      { title: '参考にしたいアカウントURL', kind: 'url', required: false },
      { title: '投稿頻度', kind: 'choice', choices: ['週1回', '週2回', '週3回以上'], required: true },
    ],
    categories: ['投稿画像', 'プロフィール画像', 'ストーリーズ'],
    checklist: ['文言・誤字', '色味', 'ロゴの扱い'],
  },
  {
    name: 'LP制作',
    description: 'ランディングページ制作',
    clientGuidance: '掲載する原稿・画像をご提出ください。デザイン案をポータルでご確認いただきます。',
    requests: [
      { title: 'ロゴデータ', kind: 'file', required: true },
      { title: '掲載原稿', kind: 'file', required: true },
      { title: '商品・サービス写真', kind: 'file', required: true },
      { title: 'ブランドカラー', description: 'カラーコードがあればご記入ください', kind: 'text', required: false },
      { title: '参考サイトURL', kind: 'url', required: false },
    ],
    categories: ['デザイン案', 'ワイヤーフレーム'],
    checklist: ['文言・誤字', '電話番号・住所', 'ボタンの遷移先'],
  },
  {
    name: '動画編集',
    description: '素材動画の編集・納品',
    clientGuidance: '撮影素材をアップロードしてください。大容量の場合は数回に分けてもかまいません。',
    requests: [
      { title: '動画素材', kind: 'file', required: true },
      { title: 'BGM・テロップの希望', kind: 'text', required: false },
      { title: '納品形式', kind: 'choice', choices: ['横長(16:9)', '縦長(9:16)', '正方形(1:1)'], required: true },
    ],
    categories: ['編集動画', 'サムネイル'],
    checklist: ['テロップ誤字', '尺', '音量'],
  },
  {
    name: '写真撮影・レタッチ',
    description: '撮影データのセレクトとレタッチ',
    clientGuidance: '撮影当日の注意事項をご確認のうえ、チェックをお願いします。',
    requests: [
      { title: '撮影当日の注意事項の確認', kind: 'check', required: true },
      { title: '撮影イメージの参考画像', kind: 'file', required: false },
    ],
    categories: ['セレクト', 'レタッチ済み'],
    checklist: ['色味', '肌・背景の修正'],
  },
  {
    name: 'バナー制作',
    description: '広告・Webバナー制作',
    clientGuidance: '掲載文と素材をご提出ください。',
    requests: [
      { title: '掲載文（キャッチコピー）', kind: 'text', required: true },
      { title: '使用する写真・ロゴ', kind: 'file', required: true },
      { title: 'サイズ', kind: 'choice', choices: ['1200x628', '1080x1080', '300x250', 'その他（コメント欄へ）'], required: true },
    ],
    categories: ['バナー'],
    checklist: ['文言・誤字', 'サイズ', '文字の読みやすさ'],
  },
];

export async function miscRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  function insertTemplate(ownerId: string, b: z.infer<typeof templateBody>): string {
    const id = newId('tpl');
    const now = nowIso();
    db.prepare(
      `INSERT INTO templates (id, owner_id, name, description, client_guidance, requests_json, categories_json, checklist_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, ownerId, b.name, b.description, b.clientGuidance, JSON.stringify(b.requests), JSON.stringify(b.categories), JSON.stringify(b.checklist), now, now);
    return id;
  }

  app.get('/api/app/templates', async (req) => {
    const op = requireOperator(ctx, req);
    let rows = db.prepare('SELECT * FROM templates WHERE owner_id = ? ORDER BY name').all(op.id) as TemplateRow[];
    const seeded = db.prepare(`SELECT 1 FROM audit_log WHERE owner_id = ? AND action = 'template.defaults_created'`).get(op.id);
    if (rows.length === 0 && !seeded) {
      db.transaction(() => {
        for (const t of DEFAULT_TEMPLATES) insertTemplate(op.id, templateBody.parse(t));
        audit(db, { ownerId: op.id, actor: opActor(op), action: 'template.defaults_created' });
      })();
      rows = db.prepare('SELECT * FROM templates WHERE owner_id = ? ORDER BY name').all(op.id) as TemplateRow[];
    }
    return { templates: rows.map(templateDto) };
  });

  app.post('/api/app/templates', async (req) => {
    const op = requireOperator(ctx, req);
    const b = templateBody.parse(req.body);
    const id = insertTemplate(op.id, b);
    audit(db, { ownerId: op.id, actor: opActor(op), action: 'template.created', targetType: 'template', targetId: id, summary: b.name, ...reqMeta(ctx, req) });
    return { id };
  });

  /** 既存案件から新テンプレートを作成 */
  app.post('/api/app/projects/:id/save-as-template', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = db.prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?').get(id, op.id) as
      | { id: string; name: string; client_guidance: string; categories_json: string; checklist_json: string }
      | undefined;
    if (!p) throw notFound('案件');
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    const reqs = db.prepare('SELECT title, description, kind, required, choices_json FROM document_requests WHERE project_id = ? ORDER BY sort_order').all(p.id) as {
      title: string;
      description: string;
      kind: 'file';
      required: number;
      choices_json: string;
    }[];
    const tid = insertTemplate(
      op.id,
      templateBody.parse({
        name,
        clientGuidance: p.client_guidance,
        categories: parseJsonArray(p.categories_json),
        checklist: parseJsonArray(p.checklist_json),
        requests: reqs.map((r) => ({ title: r.title, description: r.description, kind: r.kind, required: !!r.required, choices: parseJsonArray(r.choices_json) })),
      }),
    );
    return { id: tid };
  });

  app.patch('/api/app/templates/:tid', async (req) => {
    const op = requireOperator(ctx, req);
    const { tid } = req.params as { tid: string };
    const t = db.prepare('SELECT * FROM templates WHERE id = ? AND owner_id = ?').get(tid, op.id) as TemplateRow | undefined;
    if (!t) throw notFound('テンプレート');
    const b = templateBody.parse(req.body);
    // テンプレートの編集は既存案件に影響しない（案件作成時に複製済み）
    db.prepare(
      `UPDATE templates SET name = ?, description = ?, client_guidance = ?, requests_json = ?, categories_json = ?, checklist_json = ?, updated_at = ? WHERE id = ?`,
    ).run(b.name, b.description, b.clientGuidance, JSON.stringify(b.requests), JSON.stringify(b.categories), JSON.stringify(b.checklist), nowIso(), t.id);
    return { ok: true };
  });

  app.delete('/api/app/templates/:tid', async (req) => {
    const op = requireOperator(ctx, req);
    const { tid } = req.params as { tid: string };
    const r = db.prepare('DELETE FROM templates WHERE id = ? AND owner_id = ?').run(tid, op.id);
    if (r.changes === 0) throw notFound('テンプレート');
    return { ok: true };
  });

  // ---- 通知 ----

  app.get('/api/app/notifications', async (req) => {
    const op = requireOperator(ctx, req);
    const rows = db
      .prepare(
        `SELECT n.id, n.kind, n.title, n.body, n.link, n.created_at, n.read_at, n.project_id, p.name project_name FROM notifications n
         LEFT JOIN projects p ON p.id = n.project_id
         WHERE n.recipient_type = 'operator' AND n.recipient_id = ? ORDER BY n.created_at DESC LIMIT 200`,
      )
      .all(op.id) as { id: string; kind: string; title: string; body: string; link: string; created_at: string; read_at: string | null; project_id: string | null; project_name: string | null }[];
    const unread = (db.prepare(`SELECT COUNT(*) n FROM notifications WHERE recipient_type = 'operator' AND recipient_id = ? AND read_at IS NULL`).get(op.id) as { n: number }).n;
    return {
      unread,
      notifications: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        link: r.link,
        createdAt: r.created_at,
        read: !!r.read_at,
        projectId: r.project_id,
        projectName: r.project_name,
      })),
    };
  });

  app.post('/api/app/notifications/read', async (req) => {
    const op = requireOperator(ctx, req);
    const b = z.object({ ids: z.array(z.string().max(40)).max(200).optional(), all: z.boolean().optional() }).parse(req.body);
    if (b.all) db.prepare(`UPDATE notifications SET read_at = ? WHERE recipient_type = 'operator' AND recipient_id = ? AND read_at IS NULL`).run(nowIso(), op.id);
    else for (const id of b.ids ?? []) db.prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND recipient_type = 'operator' AND recipient_id = ?`).run(nowIso(), id, op.id);
    return { ok: true };
  });

  app.get('/api/app/notification-settings', async (req) => {
    const op = requireOperator(ctx, req);
    const s = db.prepare(`SELECT email_enabled FROM notification_settings WHERE recipient_type = 'operator' AND recipient_id = ?`).get(op.id) as { email_enabled: number } | undefined;
    return { emailEnabled: s ? !!s.email_enabled : true, mailAvailable: ctx.mailer.enabled };
  });

  app.put('/api/app/notification-settings', async (req) => {
    const op = requireOperator(ctx, req);
    const b = z.object({ emailEnabled: z.boolean() }).parse(req.body);
    db.prepare(
      `INSERT INTO notification_settings (recipient_type, recipient_id, email_enabled) VALUES ('operator', ?, ?)
       ON CONFLICT(recipient_type, recipient_id) DO UPDATE SET email_enabled = excluded.email_enabled`,
    ).run(op.id, b.emailEnabled ? 1 : 0);
    return { ok: true };
  });

  // ---- 監査ログ ----

  app.get('/api/app/audit', async (req) => {
    const op = requireOperator(ctx, req);
    const q = z
      .object({ projectId: z.string().max(40).default(''), action: z.string().max(60).default(''), before: z.coerce.number().int().optional() })
      .parse(req.query);
    const rows = db
      .prepare(
        `SELECT a.seq, a.project_id, p.name project_name, a.actor_type, a.actor_name, a.action, a.target_type, a.target_id, a.summary, a.detail_json,
                a.ip_hash, a.user_agent, a.created_at, a.hash
         FROM audit_log a LEFT JOIN projects p ON p.id = a.project_id
         WHERE a.owner_id = ? AND (? = '' OR a.project_id = ?) AND (? = '' OR a.action LIKE ?) AND (? IS NULL OR a.seq < ?)
         ORDER BY a.seq DESC LIMIT 200`,
      )
      .all(op.id, q.projectId, q.projectId, q.action, `${q.action}%`, q.before ?? null, q.before ?? null) as Record<string, unknown>[];
    return {
      events: rows.map((r) => ({
        seq: r.seq,
        projectId: r.project_id,
        projectName: r.project_name,
        actorType: r.actor_type,
        actorName: r.actor_name,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        summary: r.summary,
        detail: JSON.parse(r.detail_json as string),
        ipHash: r.ip_hash,
        userAgent: r.user_agent,
        at: r.created_at,
        hash: (r.hash as string).slice(0, 16),
      })),
    };
  });

  app.get('/api/app/audit/verify', async (req) => {
    requireOperator(ctx, req);
    return verifyAuditChain(db);
  });

  // ---- 全データエクスポート（自分のデータのみ） ----

  app.get('/api/app/export', { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const op = requireOperator(ctx, req);
    const own = (sql: string) => db.prepare(sql).all(op.id);
    const data = {
      format: 'client-portal-export',
      appVersion: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      operator: db.prepare('SELECT id, email, name, business_name, created_at FROM operators WHERE id = ?').get(op.id),
      clients: own('SELECT * FROM clients WHERE owner_id = ?'),
      templates: own('SELECT * FROM templates WHERE owner_id = ?'),
      projects: own('SELECT * FROM projects WHERE owner_id = ?'),
      projectStatusHistory: own('SELECT h.* FROM project_status_history h JOIN projects p ON p.id = h.project_id WHERE p.owner_id = ?'),
      portalAccess: own('SELECT a.* FROM portal_access a JOIN projects p ON p.id = a.project_id WHERE p.owner_id = ?'),
      documentRequests: own('SELECT r.* FROM document_requests r JOIN projects p ON p.id = r.project_id WHERE p.owner_id = ?'),
      files: own(`SELECT id, project_id, uploader_type, uploader_id, original_name, mime, size, sha256, purpose, request_id, version_group_id, version_number, preview_kind, status, created_at FROM files WHERE owner_id = ?`),
      deliverables: own('SELECT d.* FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE p.owner_id = ?'),
      versions: own('SELECT v.* FROM deliverable_versions v JOIN projects p ON p.id = v.project_id WHERE p.owner_id = ?'),
      comments: own('SELECT c.* FROM comments c JOIN projects p ON p.id = c.project_id WHERE p.owner_id = ?'),
      changeRequests: own('SELECT c.* FROM change_requests c JOIN projects p ON p.id = c.project_id WHERE p.owner_id = ?'),
      approvals: own('SELECT a.* FROM approvals a JOIN projects p ON p.id = a.project_id WHERE p.owner_id = ?'),
      deliveries: own('SELECT d.* FROM deliveries d JOIN projects p ON p.id = d.project_id WHERE p.owner_id = ?'),
      deliveryItems: own('SELECT i.* FROM delivery_items i JOIN deliveries d ON d.id = i.delivery_id JOIN projects p ON p.id = d.project_id WHERE p.owner_id = ?'),
      auditLog: own('SELECT seq, id, project_id, actor_type, actor_id, actor_name, action, target_type, target_id, summary, detail_json, created_at, hash FROM audit_log WHERE owner_id = ? ORDER BY seq'),
    };
    const files = db.prepare('SELECT * FROM files WHERE owner_id = ? ORDER BY project_id, created_at').all(op.id) as FileRow[];
    audit(db, { ownerId: op.id, actor: opActor(op), action: 'operator.exported', detail: { files: files.length }, ...reqMeta(ctx, req) });
    const archive = new ZipArchive({ store: true });
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', contentDisposition('attachment', `client-portal-export-${nowIso().slice(0, 10)}.zip`));
    reply.send(archive);
    (async () => {
      try {
        archive.append(JSON.stringify(data, null, 2), { name: 'data.json' });
        archive.append(
          'このZIPには Client Portal に保存されたあなたのデータ（顧客・案件・資料・制作物・コメント・承認・納品・監査ログ）とファイル実体が含まれます。\nfiles/<案件ID>/<ファイルID>_<元ファイル名> がファイル実体、data.json の files が対応表です。\n',
          { name: 'README.txt' },
        );
        for (const f of files) {
          const obj = await ctx.storage.get(f.storage_key);
          archive.append(obj.stream, { name: `files/${f.project_id}/${f.id}_${safeFileName(f.original_name)}` });
          await new Promise((r) => archive.once('entry', r));
        }
        await archive.finalize();
      } catch (e) {
        ctx.log.error({ err: (e as Error).message }, 'export failed');
        archive.abort();
        reply.raw.destroy();
      }
    })();
    return reply;
  });

  // ---- サンプル ----

  app.post('/api/app/sample', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const op = requireOperator(ctx, req);
    const exists = db.prepare('SELECT 1 FROM projects WHERE owner_id = ? AND is_sample = 1').get(op.id);
    if (exists) throw conflict('サンプル案件は作成済みです。削除してから作り直してください');
    return createSampleProject(ctx, op);
  });

  app.delete('/api/app/sample', async (req) => {
    const op = requireOperator(ctx, req);
    return deleteSampleData(ctx, op);
  });

  app.get('/api/app/about', async (req) => {
    requireOperator(ctx, req);
    return {
      appVersion: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      storageDriver: ctx.storage.name,
      mailEnabled: ctx.mailer.enabled,
      limits: ctx.cfg.limits,
      inviteDefaultDays: ctx.cfg.invite.defaultDays,
    };
  });
}

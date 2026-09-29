import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireClient } from '../auth.js';
import { clientProject, clientProjects, projectDeliverable } from '../access.js';
import { audit } from '../audit.js';
import type { Actor, ClientRow, Ctx, DeliverableRow, DeliveryRow, RequestRow } from '../context.js';
import { HttpError, badRequest, conflict, notFound, nowIso } from '../util.js';
import { reqMeta } from './auth.js';
import { deliverableDto, deliveryDto, projectDto, requestDto } from '../services/dto.js';
import { clientTodo } from '../services/summary.js';
import { approveVersion, createComment, deleteComment, editComment, listComments, requestChanges, resolveComment, revokeApproval } from '../services/review.js';
import { notify } from '../notify.js';
import { commentBody } from './app-deliverables.js';
import { assertZipSize, buildZipEntries, streamZip } from '../services/zip.js';
import { safeFileName } from '../util.js';

function clientActor(c: ClientRow): Actor & { type: 'client' } {
  return { type: 'client', id: c.id, name: c.contact_name || c.company_name };
}

export async function portalRoutes(app: FastifyInstance) {
  const ctx: Ctx = app.ctx;
  const { db } = ctx;

  function load(req: FastifyRequest) {
    const c = requireClient(ctx, req);
    const { id } = req.params as { id: string };
    const p = clientProject(db, c, id);
    return { c, p, actor: clientActor(c), meta: reqMeta(ctx, req) };
  }

  app.get('/api/portal/projects', async (req) => {
    const c = requireClient(ctx, req);
    return {
      projects: clientProjects(db, c).map((p) => {
        const todo = clientTodo(db, p.id, c.id);
        return {
          ...projectDto(p, 'client'),
          todoCount: todo.requests.toSubmit.length + todo.reviews.length + todo.deliveries.filter((d) => !d.downloaded && !d.expired).length,
        };
      }),
    };
  });

  app.get('/api/portal/projects/:id', async (req) => {
    const { c, p } = load(req);
    const op = db.prepare('SELECT name, business_name FROM operators WHERE id = ?').get(p.owner_id) as { name: string; business_name: string };
    return { project: projectDto(p, 'client'), providerName: op.business_name || op.name, todo: clientTodo(db, p.id, c.id) };
  });

  app.get('/api/portal/projects/:id/requests', async (req) => {
    const { p } = load(req);
    const rows = db.prepare('SELECT * FROM document_requests WHERE project_id = ? ORDER BY sort_order, created_at').all(p.id) as RequestRow[];
    return { requests: rows.map((r) => requestDto(db, r, 'client')) };
  });

  app.post('/api/portal/projects/:id/requests/:rid/submit', async (req) => {
    const { c, p, actor, meta } = load(req);
    const { rid } = req.params as { rid: string };
    const r = db.prepare('SELECT * FROM document_requests WHERE id = ? AND project_id = ?').get(rid, p.id) as RequestRow | undefined;
    if (!r) throw notFound('資料リクエスト');
    if (r.status !== 'pending' && r.status !== 'returned') throw conflict('この項目は提出済みです', 'already_submitted');
    const b = z
      .object({
        text: z.string().max(20000).optional(),
        url: z.string().trim().max(2000).optional(),
        choice: z.string().max(100).optional(),
        checked: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    let answer: { text: string | null; url: string | null; choice: string | null; checked: number | null } = { text: null, url: null, choice: null, checked: null };
    switch (r.kind) {
      case 'file': {
        const n = (db.prepare(`SELECT COUNT(*) n FROM files WHERE request_id = ? AND status = 'active'`).get(r.id) as { n: number }).n;
        if (n === 0) throw badRequest('ファイルを1つ以上アップロードしてください');
        answer.text = b.text?.trim() || null;
        break;
      }
      case 'text':
        if (!b.text?.trim()) throw badRequest('回答を入力してください');
        answer.text = b.text.trim();
        break;
      case 'url': {
        const u = b.url ?? '';
        let parsed: URL;
        try {
          parsed = new URL(u);
        } catch {
          throw badRequest('URLの形式が正しくありません（https:// から入力してください）');
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw badRequest('http または https のURLを入力してください');
        answer.url = parsed.toString();
        answer.text = b.text?.trim() || null;
        break;
      }
      case 'choice': {
        const choices = JSON.parse(r.choices_json) as string[];
        if (!b.choice || !choices.includes(b.choice)) throw badRequest('選択肢から選んでください');
        answer.choice = b.choice;
        answer.text = b.text?.trim() || null;
        break;
      }
      case 'check':
        if (b.checked !== true) throw badRequest('内容を確認してチェックを入れてください');
        answer.checked = 1;
        break;
    }
    db.transaction(() => {
      // アップロード・回答だけでは「確認済み」にしない。運営者の確認で accepted になる
      db.prepare(
        `UPDATE document_requests SET status = 'submitted', answer_text = ?, answer_url = ?, answer_choice = ?, answer_checked = ?, submitted_at = ?, submitted_by = ?, updated_at = ? WHERE id = ?`,
      ).run(answer.text, answer.url, answer.choice, answer.checked, nowIso(), c.id, nowIso(), r.id);
      db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), p.id);
      audit(db, {
        ownerId: p.owner_id,
        projectId: p.id,
        actor,
        action: 'request.submitted',
        targetType: 'request',
        targetId: r.id,
        summary: `「${r.title}」を提出`,
        clientVisible: true,
        ...meta,
      });
      notify(ctx, {
        ownerId: p.owner_id,
        recipientType: 'operator',
        recipientId: p.owner_id,
        projectId: p.id,
        kind: 'request_submitted',
        title: `資料が提出されました: ${r.title}（${actor.name}）`,
        link: `/app/projects/${p.id}?tab=requests`,
        dedupeKey: `reqsub:${r.id}:${Date.now()}`,
      });
    })();
    return { ok: true };
  });

  app.get('/api/portal/projects/:id/deliverables', async (req) => {
    const { p } = load(req);
    const rows = db
      .prepare(
        `SELECT d.* FROM deliverables d WHERE d.project_id = ? AND EXISTS (SELECT 1 FROM deliverable_versions v WHERE v.deliverable_id = d.id)
         ORDER BY d.sort_order, d.created_at`,
      )
      .all(p.id) as DeliverableRow[];
    return {
      deliverables: rows.map((d) => {
        const dto = deliverableDto(db, d, 'client');
        const latest = dto.versions[0];
        return {
          id: dto.id,
          title: dto.title,
          category: dto.category,
          status: dto.status,
          statusLabel: dto.statusLabel,
          latestVersionNumber: dto.latestVersionNumber,
          latestVersionId: latest?.id,
          submittedAt: latest?.submittedAt,
          reviewDueDate: latest?.reviewDueDate,
          previewKind: latest?.file.previewKind,
          thumbUrl: latest?.file.previewKind === 'image' ? latest.file.url : null,
          openCommentCount: latest?.openCommentCount ?? 0,
        };
      }),
    };
  });

  app.get('/api/portal/projects/:id/deliverables/:did', async (req) => {
    const { c, p } = load(req);
    const { did } = req.params as { did: string };
    const d = projectDeliverable(db, p.id, did);
    const dto = deliverableDto(db, d, 'client');
    if (dto.versions.length === 0) throw notFound('制作物');
    const viewer = { type: 'client', id: c.id };
    const comments = Object.fromEntries(dto.versions.map((v) => [v.id, listComments(ctx, v.id, viewer)]));
    return { deliverable: dto, comments };
  });

  app.post('/api/portal/projects/:id/versions/:vid/comments', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { p, actor, meta } = load(req);
    const { vid } = req.params as { vid: string };
    const b = commentBody.parse(req.body);
    return createComment(ctx, p, actor, vid, b, meta);
  });

  app.patch('/api/portal/projects/:id/comments/:cid', async (req) => {
    const { p, actor, meta } = load(req);
    const { cid } = req.params as { cid: string };
    const b = z.object({ body: z.string().max(4000) }).parse(req.body);
    editComment(ctx, p, cid, actor, b.body, meta);
    return { ok: true };
  });

  app.delete('/api/portal/projects/:id/comments/:cid', async (req) => {
    const { p, actor, meta } = load(req);
    const { cid } = req.params as { cid: string };
    deleteComment(ctx, p, cid, actor, meta);
    return { ok: true };
  });

  app.post('/api/portal/projects/:id/comments/:cid/resolve', async (req) => {
    const { p, actor, meta } = load(req);
    const { cid } = req.params as { cid: string };
    const b = z.object({ resolved: z.boolean() }).parse(req.body);
    resolveComment(ctx, p, cid, actor, b.resolved, meta);
    return { ok: true };
  });

  app.post('/api/portal/projects/:id/versions/:vid/change-request', async (req) => {
    const { c, p, actor, meta } = load(req);
    const { vid } = req.params as { vid: string };
    const b = z.object({ body: z.string().max(4000) }).parse(req.body);
    return requestChanges(ctx, p, { id: c.id, name: actor.name }, vid, b.body, meta);
  });

  app.post('/api/portal/projects/:id/versions/:vid/approve', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { c, p, actor, meta } = load(req);
    const { vid } = req.params as { vid: string };
    const b = z
      .object({
        idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, '不正なリクエストです'),
        expectedVersionNumber: z.number().int().min(1),
        comment: z.string().max(1000).default(''),
        confirm: z.literal(true, { message: '確認のチェックが必要です' }),
      })
      .parse(req.body);
    return approveVersion(ctx, p, { id: c.id, name: actor.name }, { versionId: vid, idempotencyKey: `${c.id}:${b.idempotencyKey}`, expectedVersionNumber: b.expectedVersionNumber, comment: b.comment }, meta);
  });

  app.post('/api/portal/projects/:id/approvals/:aid/revoke', async (req) => {
    const { p, actor, meta } = load(req);
    const { aid } = req.params as { aid: string };
    const b = z.object({ reason: z.string().max(1000) }).parse(req.body);
    revokeApproval(ctx, p, aid, actor, b.reason, meta);
    return { ok: true };
  });

  app.get('/api/portal/projects/:id/deliveries', async (req) => {
    const { p } = load(req);
    const rows = db.prepare(`SELECT * FROM deliveries WHERE project_id = ? AND status = 'published' ORDER BY published_at DESC`).all(p.id) as DeliveryRow[];
    return {
      deliveries: rows.map((d) => {
        const dto = deliveryDto(db, d, 'client');
        return {
          ...dto,
          items: dto.items.map((i) => ({
            ...i,
            file: { ...i.file, url: `${i.file.url}?delivery=${d.id}`, downloadUrl: `${i.file.url}?dl=1&delivery=${d.id}` },
          })),
        };
      }),
    };
  });

  app.get('/api/portal/projects/:id/deliveries/:did/zip', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { p, actor, meta } = load(req);
    const { did } = req.params as { did: string };
    const d = db.prepare(`SELECT * FROM deliveries WHERE id = ? AND project_id = ? AND status = 'published'`).get(did, p.id) as DeliveryRow | undefined;
    if (!d) throw notFound('納品');
    if (d.expires_at && Date.parse(d.expires_at) < Date.now()) throw new HttpError(410, 'expired', 'ダウンロード期限が過ぎています。担当者にご連絡ください');
    const entries = buildZipEntries(ctx, d);
    assertZipSize(ctx, entries);
    audit(db, {
      ownerId: p.owner_id,
      projectId: p.id,
      actor,
      action: 'delivery.zip_downloaded',
      targetType: 'delivery',
      targetId: d.id,
      summary: `納品「${d.title}」を一括ダウンロード（${entries.length}件）`,
      detail: { files: entries.length },
      clientVisible: true,
      ...meta,
    });
    await streamZip(ctx, reply, `${safeFileName(d.title, 'delivery')}.zip`, entries);
    return reply;
  });

  app.get('/api/portal/projects/:id/activity', async (req) => {
    const { p } = load(req);
    const rows = db
      .prepare(
        `SELECT seq, actor_type, actor_name, action, summary, created_at FROM audit_log
         WHERE project_id = ? AND client_visible = 1 ORDER BY seq DESC LIMIT 100`,
      )
      .all(p.id) as { seq: number; actor_type: string; actor_name: string; action: string; summary: string; created_at: string }[];
    return {
      events: rows.map((r) => ({
        seq: r.seq,
        actorType: r.actor_type,
        actorName: r.actor_type === 'system' ? '' : r.actor_name,
        action: r.action,
        summary: r.summary,
        at: r.created_at,
      })),
    };
  });

  app.get('/api/portal/notifications', async (req) => {
    const c = requireClient(ctx, req);
    const rows = db
      .prepare(
        `SELECT n.id, n.kind, n.title, n.body, n.link, n.created_at, n.read_at, n.project_id FROM notifications n
         WHERE n.recipient_type = 'client' AND n.recipient_id = ?
           AND (n.project_id IS NULL OR n.project_id IN (SELECT project_id FROM portal_access WHERE client_id = ? AND status = 'active'))
         ORDER BY n.created_at DESC LIMIT 100`,
      )
      .all(c.id, c.id) as { id: string; kind: string; title: string; body: string; link: string; created_at: string; read_at: string | null; project_id: string | null }[];
    return {
      unread: rows.filter((r) => !r.read_at).length,
      notifications: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, createdAt: r.created_at, read: !!r.read_at, projectId: r.project_id })),
    };
  });

  app.post('/api/portal/notifications/read', async (req) => {
    const c = requireClient(ctx, req);
    const b = z.object({ ids: z.array(z.string().max(40)).max(200).optional(), all: z.boolean().optional() }).parse(req.body);
    if (b.all) db.prepare(`UPDATE notifications SET read_at = ? WHERE recipient_type = 'client' AND recipient_id = ? AND read_at IS NULL`).run(nowIso(), c.id);
    else for (const id of b.ids ?? []) db.prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND recipient_type = 'client' AND recipient_id = ?`).run(nowIso(), id, c.id);
    return { ok: true };
  });

  app.get('/api/portal/notification-settings', async (req) => {
    const c = requireClient(ctx, req);
    const s = db.prepare(`SELECT email_enabled FROM notification_settings WHERE recipient_type = 'client' AND recipient_id = ?`).get(c.id) as { email_enabled: number } | undefined;
    return { emailEnabled: s ? !!s.email_enabled : true, mailAvailable: ctx.mailer.enabled };
  });

  app.put('/api/portal/notification-settings', async (req) => {
    const c = requireClient(ctx, req);
    const b = z.object({ emailEnabled: z.boolean() }).parse(req.body);
    db.prepare(
      `INSERT INTO notification_settings (recipient_type, recipient_id, email_enabled) VALUES ('client', ?, ?)
       ON CONFLICT(recipient_type, recipient_id) DO UPDATE SET email_enabled = excluded.email_enabled`,
    ).run(c.id, b.emailEnabled ? 1 : 0);
    return { ok: true };
  });
}

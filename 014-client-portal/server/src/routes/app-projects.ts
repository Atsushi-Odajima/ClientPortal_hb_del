import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOperator } from '../auth.js';
import { ownedClient, ownedProject } from '../access.js';
import { audit } from '../audit.js';
import type { Actor, ClientRow, Ctx, DeliverableRow, DeliveryRow, FileRow, OperatorRow, ProjectRow, RequestRow } from '../context.js';
import { HttpError, addDays, badRequest, conflict, newId, newToken, notFound, nowIso, parseJsonArray, patchSchema, sha256Hex } from '../util.js';
import { reqMeta } from './auth.js';
import { clientDto } from './app-clients.js';
import { deliverableDto, deliveryDto, fileDto, projectDto, requestDto } from '../services/dto.js';
import { setProjectStatus } from '../services/projectState.js';
import { notifyProjectClients, notify } from '../notify.js';
import { operatorDashboard } from '../services/summary.js';
import { deleteProjectCompletely } from '../services/deleteProject.js';
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL, type ProjectStatus } from '../../../shared/labels.js';

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日付の形式が正しくありません')
  .nullable()
  .optional();

const projectBody = z.object({
  clientId: z.string().max(40),
  name: z.string().trim().min(1, '案件名を入力してください').max(120),
  description: z.string().max(5000).default(''),
  startDate: dateStr,
  dueDate: dateStr,
  clientGuidance: z.string().max(5000).default(''),
  internalMemo: z.string().max(10000).default(''),
  clientStatusLabel: z.string().max(60).default(''),
  templateId: z.string().max(40).optional(),
});

export const requestBody = z.object({
  title: z.string().trim().min(1, 'タイトルを入力してください').max(120),
  description: z.string().max(3000).default(''),
  kind: z.enum(['file', 'text', 'url', 'choice', 'check']),
  required: z.boolean().default(true),
  dueDate: dateStr,
  choices: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  internalMemo: z.string().max(3000).default(''),
});

export function opActor(op: OperatorRow): Actor {
  return { type: 'operator', id: op.id, name: op.name };
}

export function insertRequest(ctx: Ctx, projectId: string, r: z.infer<typeof requestBody>, sortOrder: number): string {
  if (r.kind === 'choice' && r.choices.length < 2) throw badRequest('選択肢を2つ以上入力してください');
  const id = newId('req');
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO document_requests (id, project_id, title, description, kind, required, due_date, choices_json, internal_memo, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, r.title, r.description, r.kind, r.required ? 1 : 0, r.dueDate ?? null, JSON.stringify(r.choices), r.internalMemo, sortOrder, now, now);
  return id;
}

export function createInvite(ctx: Ctx, project: ProjectRow, client: ClientRow, op: OperatorRow, days: number) {
  const { db, cfg } = ctx;
  let access = db.prepare('SELECT * FROM portal_access WHERE project_id = ? AND client_id = ?').get(project.id, client.id) as
    | { id: string; status: string }
    | undefined;
  const now = nowIso();
  if (!access) {
    access = { id: newId('acc'), status: 'active' };
    db.prepare('INSERT INTO portal_access (id, project_id, client_id, status, created_at) VALUES (?, ?, ?, ?, ?)').run(access.id, project.id, client.id, 'active', now);
  } else if (access.status !== 'active') {
    db.prepare(`UPDATE portal_access SET status = 'active', revoked_at = NULL WHERE id = ?`).run(access.id);
  }
  // 再発行時は既存の招待リンクを失効
  db.prepare(`UPDATE invites SET revoked_at = ? WHERE access_id = ? AND kind = 'invite' AND revoked_at IS NULL`).run(now, access.id);
  const token = newToken();
  const inviteId = newId('inv');
  const expiresAt = addDays(new Date(), Math.min(Math.max(days, 1), cfg.invite.maxDays)).toISOString();
  db.prepare(
    `INSERT INTO invites (id, access_id, kind, token_hash, expires_at, created_by, created_at) VALUES (?, ?, 'invite', ?, ?, ?, ?)`,
  ).run(inviteId, access.id, sha256Hex(token), expiresAt, op.id, now);
  return { inviteId, url: `${cfg.publicUrl}/invite#t=${token}`, expiresAt, accessId: access.id };
}

export async function projectRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.get('/api/app/dashboard', async (req) => {
    const op = requireOperator(ctx, req);
    return operatorDashboard(db, op.id);
  });

  app.get('/api/app/projects', async (req) => {
    const op = requireOperator(ctx, req);
    const q = z
      .object({
        q: z.string().max(100).default(''),
        status: z.string().max(40).default(''),
        clientId: z.string().max(40).default(''),
        dueBefore: z.string().max(10).default(''),
        approval: z.enum(['', 'pending', 'all_approved', 'changes']).default(''),
        pendingRequests: z.enum(['', '1']).default(''),
        archived: z.enum(['0', '1']).default('0'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const where: string[] = ['p.owner_id = @owner'];
    const params: Record<string, unknown> = { owner: op.id, limit: q.limit, offset: q.offset };
    where.push(q.archived === '1' ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL');
    if (q.q) {
      where.push('(p.name LIKE @like OR c.company_name LIKE @like OR c.contact_name LIKE @like)');
      params.like = `%${q.q}%`;
    }
    if (q.status && (PROJECT_STATUSES as readonly string[]).includes(q.status)) {
      where.push('p.status = @status');
      params.status = q.status;
    }
    if (q.clientId) {
      where.push('p.client_id = @clientId');
      params.clientId = q.clientId;
    }
    if (q.dueBefore) {
      where.push('p.due_date IS NOT NULL AND p.due_date <= @dueBefore');
      params.dueBefore = q.dueBefore;
    }
    if (q.pendingRequests) where.push(`EXISTS (SELECT 1 FROM document_requests r WHERE r.project_id = p.id AND r.status IN ('pending','returned'))`);
    const latestCond = `dv.version_number = (SELECT MAX(version_number) FROM deliverable_versions WHERE deliverable_id = d.id)`;
    if (q.approval === 'pending') {
      where.push(`EXISTS (SELECT 1 FROM deliverables d JOIN deliverable_versions dv ON dv.deliverable_id = d.id AND ${latestCond} WHERE d.project_id = p.id AND dv.status = 'in_review')`);
    } else if (q.approval === 'changes') {
      where.push(`EXISTS (SELECT 1 FROM deliverables d JOIN deliverable_versions dv ON dv.deliverable_id = d.id AND ${latestCond} WHERE d.project_id = p.id AND dv.status = 'changes_requested')`);
    } else if (q.approval === 'all_approved') {
      where.push(`EXISTS (SELECT 1 FROM deliverables d WHERE d.project_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM deliverables d JOIN deliverable_versions dv ON dv.deliverable_id = d.id AND ${latestCond} WHERE d.project_id = p.id AND dv.status <> 'approved')
        AND NOT EXISTS (SELECT 1 FROM deliverables d WHERE d.project_id = p.id AND NOT EXISTS (SELECT 1 FROM deliverable_versions x WHERE x.deliverable_id = d.id))`);
    }
    const whereSql = where.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) n FROM projects p JOIN clients c ON c.id = p.client_id WHERE ${whereSql}`).get(params) as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT p.*, c.company_name client_name,
          (SELECT COUNT(*) FROM document_requests r WHERE r.project_id = p.id AND r.status IN ('pending','returned')) pending_requests,
          (SELECT COUNT(*) FROM document_requests r WHERE r.project_id = p.id AND r.status = 'submitted') submitted_requests,
          (SELECT COUNT(*) FROM document_requests r WHERE r.project_id = p.id) total_requests
         FROM projects p JOIN clients c ON c.id = p.client_id
         WHERE ${whereSql}
         ORDER BY p.updated_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all(params) as (ProjectRow & { client_name: string; pending_requests: number; submitted_requests: number; total_requests: number })[];
    return {
      total,
      projects: rows.map((r) => ({
        ...projectDto(r, 'operator', r.client_name),
        pendingRequests: r.pending_requests,
        submittedRequests: r.submitted_requests,
        totalRequests: r.total_requests,
      })),
    };
  });

  app.post('/api/app/projects', async (req) => {
    const op = requireOperator(ctx, req);
    const b = projectBody.parse(req.body);
    const client = ownedClient(db, op.id, b.clientId);
    if (client.status !== 'active') throw badRequest('アーカイブ済みの顧客には案件を作成できません');
    const limit = ctx.cfg.limits.maxActiveProjectsPerOperator;
    if (limit > 0) {
      const n = (db.prepare('SELECT COUNT(*) n FROM projects WHERE owner_id = ? AND archived_at IS NULL').get(op.id) as { n: number }).n;
      if (n >= limit) throw conflict(`有効な案件数の上限（${limit}件）に達しています。完了した案件をアーカイブしてください`, 'project_limit');
    }
    let tpl: { id: string; client_guidance: string; requests_json: string; categories_json: string; checklist_json: string } | undefined;
    if (b.templateId) {
      tpl = db.prepare('SELECT * FROM templates WHERE id = ? AND owner_id = ?').get(b.templateId, op.id) as typeof tpl;
      if (!tpl) throw notFound('テンプレート');
    }
    const id = newId('prj');
    const now = nowIso();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO projects (id, owner_id, client_id, name, description, start_date, due_date, client_guidance, internal_memo, client_status_label,
          categories_json, checklist_json, template_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        op.id,
        client.id,
        b.name,
        b.description,
        b.startDate ?? null,
        b.dueDate ?? null,
        b.clientGuidance || tpl?.client_guidance || '',
        b.internalMemo,
        b.clientStatusLabel,
        tpl?.categories_json ?? '[]',
        tpl?.checklist_json ?? '[]',
        tpl?.id ?? null,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO project_status_history (id, project_id, from_status, to_status, changed_by_type, changed_by_id, changed_at) VALUES (?, ?, NULL, 'preparing', 'operator', ?, ?)`,
      ).run(newId('psh'), id, op.id, now);
      // テンプレートは作成時に複製（後からテンプレートを編集しても既存案件は変わらない）
      if (tpl) {
        const reqs = parseJsonArray<unknown>(tpl.requests_json);
        reqs.forEach((r, i) => {
          const parsed = requestBody.safeParse(r);
          if (parsed.success) insertRequest(ctx, id, parsed.data, i);
        });
      }
      audit(db, {
        ownerId: op.id,
        projectId: id,
        actor: opActor(op),
        action: 'project.created',
        targetType: 'project',
        targetId: id,
        summary: b.name,
        ...reqMeta(ctx, req),
      });
    })();
    return { id };
  });

  app.get('/api/app/projects/:id', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id) as ClientRow;
    const requests = (db.prepare('SELECT * FROM document_requests WHERE project_id = ? ORDER BY sort_order, created_at').all(p.id) as RequestRow[]).map((r) =>
      requestDto(db, r, 'operator'),
    );
    const deliverables = (db.prepare('SELECT * FROM deliverables WHERE project_id = ? ORDER BY sort_order, created_at').all(p.id) as DeliverableRow[]).map((d) =>
      deliverableDto(db, d, 'operator'),
    );
    const deliveries = (db.prepare('SELECT * FROM deliveries WHERE project_id = ? ORDER BY created_at DESC').all(p.id) as DeliveryRow[]).map((d) =>
      deliveryDto(db, d, 'operator'),
    );
    const access = db
      .prepare(
        `SELECT pa.id, pa.status, pa.created_at, pa.revoked_at, c.id client_id, c.company_name, c.contact_name, c.email FROM portal_access pa
         JOIN clients c ON c.id = pa.client_id WHERE pa.project_id = ?`,
      )
      .all(p.id) as { id: string; status: string; created_at: string; revoked_at: string | null; client_id: string; company_name: string; contact_name: string; email: string }[];
    const invites = db
      .prepare(
        `SELECT i.id, i.access_id, i.kind, i.expires_at, i.revoked_at, i.use_count, i.last_used_at, i.created_at FROM invites i
         JOIN portal_access pa ON pa.id = i.access_id WHERE pa.project_id = ? AND i.kind = 'invite' ORDER BY i.created_at DESC LIMIT 20`,
      )
      .all(p.id) as { id: string; access_id: string; expires_at: string; revoked_at: string | null; use_count: number; last_used_at: string | null; created_at: string }[];
    const internalFiles = (db.prepare(`SELECT * FROM files WHERE project_id = ? AND purpose = 'internal' AND status = 'active' ORDER BY created_at DESC`).all(p.id) as FileRow[]).map(
      (f) => fileDto(f, 'operator'),
    );
    const history = db
      .prepare('SELECT from_status, to_status, changed_by_type, note, changed_at FROM project_status_history WHERE project_id = ? ORDER BY changed_at DESC LIMIT 50')
      .all(p.id) as { from_status: string | null; to_status: ProjectStatus; changed_by_type: string; note: string; changed_at: string }[];
    return {
      project: projectDto(p, 'operator', client.company_name),
      client: clientDto(client),
      requests,
      deliverables,
      deliveries,
      internalFiles,
      access: access.map((a) => ({
        id: a.id,
        status: a.status,
        createdAt: a.created_at,
        revokedAt: a.revoked_at,
        client: { id: a.client_id, companyName: a.company_name, contactName: a.contact_name, email: a.email },
        invites: invites
          .filter((i) => i.access_id === a.id)
          .map((i) => ({
            id: i.id,
            expiresAt: i.expires_at,
            revokedAt: i.revoked_at,
            useCount: i.use_count,
            lastUsedAt: i.last_used_at,
            createdAt: i.created_at,
            active: !i.revoked_at && Date.parse(i.expires_at) > Date.now(),
          })),
      })),
      statusHistory: history.map((h) => ({
        from: h.from_status,
        to: h.to_status,
        toLabel: PROJECT_STATUS_LABEL[h.to_status],
        byType: h.changed_by_type,
        note: h.note,
        at: h.changed_at,
      })),
    };
  });

  app.patch('/api/app/projects/:id', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const b = patchSchema(
      projectBody
        .omit({ clientId: true, templateId: true })
        .extend({ categories: z.array(z.string().trim().min(1).max(60)).max(30), checklist: z.array(z.string().trim().min(1).max(200)).max(30) }),
    ).parse(req.body);
    db.prepare(
      `UPDATE projects SET name = ?, description = ?, start_date = ?, due_date = ?, client_guidance = ?, internal_memo = ?, client_status_label = ?,
        categories_json = ?, checklist_json = ?, updated_at = ? WHERE id = ?`,
    ).run(
      b.name ?? p.name,
      b.description ?? p.description,
      b.startDate === undefined ? p.start_date : b.startDate,
      b.dueDate === undefined ? p.due_date : b.dueDate,
      b.clientGuidance ?? p.client_guidance,
      b.internalMemo ?? p.internal_memo,
      b.clientStatusLabel ?? p.client_status_label,
      b.categories ? JSON.stringify(b.categories) : p.categories_json,
      b.checklist ? JSON.stringify(b.checklist) : p.checklist_json,
      nowIso(),
      p.id,
    );
    audit(db, {
      ownerId: op.id,
      projectId: p.id,
      actor: opActor(op),
      action: 'project.updated',
      targetType: 'project',
      targetId: p.id,
      detail: { fields: Object.keys(b).filter((k) => k !== 'internalMemo') },
      ...reqMeta(ctx, req),
    });
    return { ok: true };
  });

  app.post('/api/app/projects/:id/status', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const b = z.object({ status: z.enum(PROJECT_STATUSES), note: z.string().max(500).default('') }).parse(req.body);
    db.transaction(() => setProjectStatus(ctx, p, b.status, opActor(op), b.note))();
    return { ok: true };
  });

  app.post('/api/app/projects/:id/portal', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const { portalStatus } = z.object({ portalStatus: z.enum(['draft', 'published', 'closed']) }).parse(req.body);
    db.prepare('UPDATE projects SET portal_status = ?, updated_at = ? WHERE id = ?').run(portalStatus, nowIso(), p.id);
    audit(db, {
      ownerId: op.id,
      projectId: p.id,
      actor: opActor(op),
      action: 'project.portal_status',
      targetType: 'project',
      targetId: p.id,
      summary: `ポータル: ${portalStatus}`,
      ...reqMeta(ctx, req),
    });
    return { ok: true };
  });

  app.post('/api/app/projects/:id/archive', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
    db.prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?').run(archived ? nowIso() : null, nowIso(), p.id);
    audit(db, {
      ownerId: op.id,
      projectId: p.id,
      actor: opActor(op),
      action: archived ? 'project.archived' : 'project.unarchived',
      targetType: 'project',
      targetId: p.id,
      summary: p.name,
      ...reqMeta(ctx, req),
    });
    return { ok: true };
  });

  app.delete('/api/app/projects/:id', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body ?? {});
    if (confirmName !== p.name) throw badRequest('確認のため案件名を正確に入力してください', 'confirm_mismatch');
    const result = await deleteProjectCompletely(ctx, p, opActor(op));
    return { ok: true, ...result };
  });

  // ---- 招待・アクセス ----

  app.post('/api/app/projects/:id/invites', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const b = z.object({ days: z.number().int().min(1).max(ctx.cfg.invite.maxDays).default(ctx.cfg.invite.defaultDays), sendEmail: z.boolean().default(false) }).parse(req.body ?? {});
    const client = db.prepare('SELECT * FROM clients WHERE id = ? AND owner_id = ?').get(p.client_id, op.id) as ClientRow;
    if (client.status !== 'active') throw badRequest('アーカイブ済みの顧客は招待できません');
    const result = db.transaction(() => {
      const r = createInvite(ctx, p, client, op, b.days);
      if (p.portal_status === 'draft') {
        db.prepare(`UPDATE projects SET portal_status = 'published', updated_at = ? WHERE id = ?`).run(nowIso(), p.id);
      }
      audit(db, {
        ownerId: op.id,
        projectId: p.id,
        actor: opActor(op),
        action: 'invite.created',
        targetType: 'invite',
        targetId: r.inviteId,
        summary: `${client.company_name} を招待（期限 ${r.expiresAt.slice(0, 10)}）`,
        detail: { expiresAt: r.expiresAt, email: b.sendEmail },
        ...reqMeta(ctx, req),
      });
      if (b.sendEmail && ctx.mailer.enabled) {
        ctx.mailer.enqueue(db, {
          to: client.email,
          subject: `[Client Portal] ${p.name} 専用ページのご案内`,
          text: `${client.contact_name || client.company_name} 様\n\n${op.business_name || op.name} です。\n「${p.name}」の専用ページをご用意しました。資料のご提出、制作物のご確認・承認、納品物の受け取りはこちらからお願いいたします。\n\n${r.url}\n\n・リンクの有効期限: ${r.expiresAt.slice(0, 10)}\n・開くと、このメールアドレスの入力を求められます。\n・このリンクは他の方に転送しないでください。`,
        });
      }
      return r;
    })();
    if (b.sendEmail && ctx.mailer.enabled) void ctx.mailer.flush(db).catch(() => undefined);
    return { inviteId: result.inviteId, url: result.url, expiresAt: result.expiresAt, emailQueued: b.sendEmail && ctx.mailer.enabled };
  });

  app.post('/api/app/projects/:id/invites/:inviteId/revoke', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, inviteId } = req.params as { id: string; inviteId: string };
    const p = ownedProject(db, op.id, id);
    const inv = db
      .prepare('SELECT i.id FROM invites i JOIN portal_access pa ON pa.id = i.access_id WHERE i.id = ? AND pa.project_id = ?')
      .get(inviteId, p.id);
    if (!inv) throw notFound('招待');
    db.prepare('UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(nowIso(), inviteId);
    audit(db, { ownerId: op.id, projectId: p.id, actor: opActor(op), action: 'invite.revoked', targetType: 'invite', targetId: inviteId, ...reqMeta(ctx, req) });
    return { ok: true };
  });

  app.post('/api/app/projects/:id/access/:accessId', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, accessId } = req.params as { id: string; accessId: string };
    const p = ownedProject(db, op.id, id);
    const { action } = z.object({ action: z.enum(['revoke', 'restore']) }).parse(req.body);
    const acc = db.prepare('SELECT * FROM portal_access WHERE id = ? AND project_id = ?').get(accessId, p.id) as { id: string; client_id: string } | undefined;
    if (!acc) throw notFound('アクセス権');
    const now = nowIso();
    db.transaction(() => {
      if (action === 'revoke') {
        db.prepare(`UPDATE portal_access SET status = 'revoked', revoked_at = ? WHERE id = ?`).run(now, acc.id);
        db.prepare('UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE access_id = ?').run(now, acc.id);
      } else {
        db.prepare(`UPDATE portal_access SET status = 'active', revoked_at = NULL WHERE id = ?`).run(acc.id);
      }
      audit(db, {
        ownerId: op.id,
        projectId: p.id,
        actor: opActor(op),
        action: action === 'revoke' ? 'access.revoked' : 'access.restored',
        targetType: 'client',
        targetId: acc.client_id,
        summary: action === 'revoke' ? '顧客のアクセスを停止しました' : '顧客のアクセスを再開しました',
        ...reqMeta(ctx, req),
      });
    })();
    return { ok: true };
  });

  // ---- 資料リクエスト ----

  app.post('/api/app/projects/:id/requests', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const b = requestBody.parse(req.body);
    const max = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM document_requests WHERE project_id = ?').get(p.id) as { m: number }).m;
    const rid = db.transaction(() => {
      const rid = insertRequest(ctx, p.id, b, max + 1);
      db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), p.id);
      audit(db, {
        ownerId: op.id,
        projectId: p.id,
        actor: opActor(op),
        action: 'request.created',
        targetType: 'request',
        targetId: rid,
        summary: `資料リクエスト「${b.title}」を追加`,
        clientVisible: true,
        ...reqMeta(ctx, req),
      });
      return rid;
    })();
    return { id: rid };
  });

  function ownedRequest(projectId: string, rid: string): RequestRow {
    const r = db.prepare('SELECT * FROM document_requests WHERE id = ? AND project_id = ?').get(rid, projectId) as RequestRow | undefined;
    if (!r) throw notFound('資料リクエスト');
    return r;
  }

  app.patch('/api/app/projects/:id/requests/:rid', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, rid } = req.params as { id: string; rid: string };
    const p = ownedProject(db, op.id, id);
    const r = ownedRequest(p.id, rid);
    const b = patchSchema(requestBody).extend({ sortOrder: z.number().int().min(0).max(10000).optional() }).parse(req.body);
    if (b.kind && b.kind !== r.kind && r.status !== 'pending') throw conflict('提出後は種類を変更できません');
    db.prepare(
      `UPDATE document_requests SET title = ?, description = ?, kind = ?, required = ?, due_date = ?, choices_json = ?, internal_memo = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
    ).run(
      b.title ?? r.title,
      b.description ?? r.description,
      b.kind ?? r.kind,
      b.required === undefined ? r.required : b.required ? 1 : 0,
      b.dueDate === undefined ? r.due_date : b.dueDate,
      b.choices ? JSON.stringify(b.choices) : r.choices_json,
      b.internalMemo ?? r.internal_memo,
      b.sortOrder ?? r.sort_order,
      nowIso(),
      r.id,
    );
    return { ok: true };
  });

  app.delete('/api/app/projects/:id/requests/:rid', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, rid } = req.params as { id: string; rid: string };
    const p = ownedProject(db, op.id, id);
    const r = ownedRequest(p.id, rid);
    const hasFiles = db.prepare(`SELECT 1 FROM files WHERE request_id = ? AND status = 'active'`).get(r.id);
    if (r.status !== 'pending' || hasFiles) throw conflict('提出物がある資料リクエストは削除できません');
    db.transaction(() => {
      db.prepare('DELETE FROM document_requests WHERE id = ?').run(r.id);
      audit(db, { ownerId: op.id, projectId: p.id, actor: opActor(op), action: 'request.deleted', targetType: 'request', targetId: r.id, summary: r.title, ...reqMeta(ctx, req) });
    })();
    return { ok: true };
  });

  app.post('/api/app/projects/:id/requests/:rid/review', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, rid } = req.params as { id: string; rid: string };
    const p = ownedProject(db, op.id, id);
    const r = ownedRequest(p.id, rid);
    const b = z.object({ decision: z.enum(['accept', 'return']), reason: z.string().max(1000).default('') }).parse(req.body);
    if (r.status !== 'submitted' && !(b.decision === 'return' && r.status === 'accepted')) {
      throw conflict('提出済みの資料のみ確認・差戻しできます', 'not_submitted');
    }
    if (b.decision === 'return' && !b.reason.trim()) throw badRequest('差戻し理由を入力してください');
    db.transaction(() => {
      db.prepare(`UPDATE document_requests SET status = ?, reviewed_at = ?, return_reason = ?, updated_at = ? WHERE id = ?`).run(
        b.decision === 'accept' ? 'accepted' : 'returned',
        nowIso(),
        b.decision === 'return' ? b.reason : '',
        nowIso(),
        r.id,
      );
      db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), p.id);
      audit(db, {
        ownerId: op.id,
        projectId: p.id,
        actor: opActor(op),
        action: b.decision === 'accept' ? 'request.accepted' : 'request.returned',
        targetType: 'request',
        targetId: r.id,
        summary: b.decision === 'accept' ? `「${r.title}」を確認しました` : `「${r.title}」を差戻しました`,
        clientVisible: true,
        ...reqMeta(ctx, req),
      });
      notifyProjectClients(ctx, p.id, {
        ownerId: op.id,
        kind: b.decision === 'accept' ? 'request_accepted' : 'request_returned',
        title: b.decision === 'accept' ? `「${r.title}」を確認しました` : `「${r.title}」の再提出をお願いします`,
        body: b.decision === 'return' ? b.reason : '',
        link: `/portal/p/${p.id}/requests`,
        dedupeKey: `req:${r.id}:${b.decision}:${Date.now()}`,
      });
    })();
    return { ok: true };
  });

  app.get('/api/app/projects/:id/activity', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const rows = db
      .prepare(
        `SELECT seq, actor_type, actor_name, action, target_type, target_id, summary, client_visible, detail_json, created_at
         FROM audit_log WHERE project_id = ? ORDER BY seq DESC LIMIT 300`,
      )
      .all(p.id) as { seq: number; actor_type: string; actor_name: string; action: string; target_type: string; target_id: string; summary: string; client_visible: number; detail_json: string; created_at: string }[];
    return {
      events: rows.map((r) => ({
        seq: r.seq,
        actorType: r.actor_type,
        actorName: r.actor_name,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        summary: r.summary,
        clientVisible: !!r.client_visible,
        detail: JSON.parse(r.detail_json),
        at: r.created_at,
      })),
    };
  });

  app.get('/api/app/search', async (req) => {
    const op = requireOperator(ctx, req);
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const projects = db
      .prepare(
        `SELECT p.id, p.name, p.status, c.company_name FROM projects p JOIN clients c ON c.id = p.client_id
         WHERE p.owner_id = ? AND (p.name LIKE ? ESCAPE '\\' OR c.company_name LIKE ? ESCAPE '\\') ORDER BY p.updated_at DESC LIMIT 30`,
      )
      .all(op.id, like, like) as { id: string; name: string; status: ProjectStatus; company_name: string }[];
    const clients = db
      .prepare(
        `SELECT id, company_name, contact_name, status FROM clients WHERE owner_id = ?
         AND (company_name LIKE ? ESCAPE '\\' OR contact_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') ORDER BY company_name LIMIT 30`,
      )
      .all(op.id, like, like, like) as { id: string; company_name: string; contact_name: string; status: string }[];
    const files = db
      .prepare(
        `SELECT f.id, f.original_name, f.project_id, f.purpose, f.created_at, p.name project_name FROM files f JOIN projects p ON p.id = f.project_id
         WHERE f.owner_id = ? AND f.status = 'active' AND f.original_name LIKE ? ESCAPE '\\' ORDER BY f.created_at DESC LIMIT 50`,
      )
      .all(op.id, like) as { id: string; original_name: string; project_id: string; purpose: string; created_at: string; project_name: string }[];
    const deliverables = db
      .prepare(
        `SELECT d.id, d.title, d.project_id, p.name project_name FROM deliverables d JOIN projects p ON p.id = d.project_id
         WHERE p.owner_id = ? AND d.title LIKE ? ESCAPE '\\' ORDER BY d.updated_at DESC LIMIT 30`,
      )
      .all(op.id, like) as { id: string; title: string; project_id: string; project_name: string }[];
    return {
      projects: projects.map((p) => ({ id: p.id, name: p.name, statusLabel: PROJECT_STATUS_LABEL[p.status], clientName: p.company_name })),
      clients: clients.map((c) => ({ id: c.id, companyName: c.company_name, contactName: c.contact_name, status: c.status })),
      files: files.map((f) => ({ id: f.id, name: f.original_name, projectId: f.project_id, projectName: f.project_name, purpose: f.purpose, createdAt: f.created_at })),
      deliverables: deliverables.map((d) => ({ id: d.id, title: d.title, projectId: d.project_id, projectName: d.project_name })),
    };
  });

  // 運営者から顧客への手動リマインド（アプリ内通知 + 設定時メール）
  app.post('/api/app/projects/:id/remind', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const { message } = z.object({ message: z.string().trim().min(1).max(500) }).parse(req.body);
    const access = db.prepare(`SELECT client_id FROM portal_access WHERE project_id = ? AND status = 'active'`).all(p.id) as { client_id: string }[];
    if (access.length === 0) throw new HttpError(409, 'no_access', '招待済みの顧客がいません');
    for (const a of access) {
      notify(ctx, {
        ownerId: op.id,
        recipientType: 'client',
        recipientId: a.client_id,
        projectId: p.id,
        kind: 'overdue',
        title: `「${p.name}」ご対応のお願い`,
        body: message,
        link: `/portal/p/${p.id}`,
        dedupeKey: `remind:${p.id}:${a.client_id}:${Date.now()}`,
      });
    }
    audit(db, { ownerId: op.id, projectId: p.id, actor: opActor(op), action: 'project.reminded', targetType: 'project', targetId: p.id, ...reqMeta(ctx, req) });
    return { ok: true };
  });
}

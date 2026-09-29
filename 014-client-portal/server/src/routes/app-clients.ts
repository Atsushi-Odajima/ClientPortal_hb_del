import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOperator } from '../auth.js';
import { ownedClient } from '../access.js';
import { audit } from '../audit.js';
import { conflict, newId, nowIso, patchSchema } from '../util.js';
import { emailSchema, reqMeta } from './auth.js';
import { PROJECT_STATUS_LABEL, type ProjectStatus } from '../../../shared/labels.js';

const clientBody = z.object({
  companyName: z.string().trim().min(1, '会社名/屋号を入力してください').max(120),
  contactName: z.string().trim().max(80).default(''),
  email: emailSchema,
  phone: z.string().trim().max(40).default(''),
  internalMemo: z.string().max(5000).default(''),
});

export function clientDto(c: {
  id: string;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  internal_memo: string;
  status: string;
  is_sample: number;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: c.id,
    companyName: c.company_name,
    contactName: c.contact_name,
    email: c.email,
    phone: c.phone,
    internalMemo: c.internal_memo,
    status: c.status,
    isSample: !!c.is_sample,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

export async function clientRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.get('/api/app/clients', async (req) => {
    const op = requireOperator(ctx, req);
    const q = z.object({ status: z.enum(['active', 'archived', 'all']).default('active'), q: z.string().max(100).default('') }).parse(req.query);
    const rows = db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id AND p.archived_at IS NULL) AS project_count
         FROM clients c WHERE c.owner_id = ?
           AND (? = 'all' OR c.status = ?)
           AND (? = '' OR c.company_name LIKE ? OR c.contact_name LIKE ? OR c.email LIKE ?)
         ORDER BY c.company_name COLLATE NOCASE LIMIT 500`,
      )
      .all(op.id, q.status, q.status, q.q, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`) as (Parameters<typeof clientDto>[0] & { project_count: number })[];
    return { clients: rows.map((r) => ({ ...clientDto(r), projectCount: r.project_count })) };
  });

  app.post('/api/app/clients', async (req) => {
    const op = requireOperator(ctx, req);
    const b = clientBody.parse(req.body);
    const id = newId('cli');
    const now = nowIso();
    db.prepare(
      `INSERT INTO clients (id, owner_id, company_name, contact_name, email, phone, internal_memo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, op.id, b.companyName, b.contactName, b.email, b.phone, b.internalMemo, now, now);
    audit(db, {
      ownerId: op.id,
      actor: { type: 'operator', id: op.id, name: op.name },
      action: 'client.created',
      targetType: 'client',
      targetId: id,
      summary: b.companyName,
      ...reqMeta(ctx, req),
    });
    return { id };
  });

  app.get('/api/app/clients/:id', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const c = ownedClient(db, op.id, id);
    const projects = db
      .prepare('SELECT id, name, status, due_date, archived_at, portal_status, updated_at FROM projects WHERE client_id = ? AND owner_id = ? ORDER BY updated_at DESC')
      .all(c.id, op.id) as { id: string; name: string; status: ProjectStatus; due_date: string | null; archived_at: string | null; portal_status: string; updated_at: string }[];
    const sessions = (db.prepare('SELECT COUNT(*) n FROM client_sessions WHERE client_id = ? AND expires_at > ?').get(c.id, nowIso()) as { n: number }).n;
    return {
      client: clientDto(c),
      activeSessions: sessions,
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        statusLabel: PROJECT_STATUS_LABEL[p.status],
        dueDate: p.due_date,
        archived: !!p.archived_at,
        portalStatus: p.portal_status,
        updatedAt: p.updated_at,
      })),
    };
  });

  app.patch('/api/app/clients/:id', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const c = ownedClient(db, op.id, id);
    const b = patchSchema(clientBody).parse(req.body);
    db.prepare(
      `UPDATE clients SET company_name = ?, contact_name = ?, email = ?, phone = ?, internal_memo = ?, updated_at = ? WHERE id = ?`,
    ).run(
      b.companyName ?? c.company_name,
      b.contactName ?? c.contact_name,
      b.email ?? c.email,
      b.phone ?? c.phone,
      b.internalMemo ?? c.internal_memo,
      nowIso(),
      c.id,
    );
    audit(db, {
      ownerId: op.id,
      actor: { type: 'operator', id: op.id, name: op.name },
      action: 'client.updated',
      targetType: 'client',
      targetId: c.id,
      detail: { fields: Object.keys(b).filter((k) => k !== 'internalMemo') },
      ...reqMeta(ctx, req),
    });
    return { ok: true };
  });

  app.post('/api/app/clients/:id/archive', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
    const c = ownedClient(db, op.id, id);
    db.transaction(() => {
      db.prepare('UPDATE clients SET status = ?, updated_at = ? WHERE id = ?').run(archived ? 'archived' : 'active', nowIso(), c.id);
      // アーカイブした顧客はポータルにアクセスできない（セッションも破棄）
      if (archived) db.prepare('DELETE FROM client_sessions WHERE client_id = ?').run(c.id);
      audit(db, {
        ownerId: op.id,
        actor: { type: 'operator', id: op.id, name: op.name },
        action: archived ? 'client.archived' : 'client.unarchived',
        targetType: 'client',
        targetId: c.id,
        summary: c.company_name,
        ...reqMeta(ctx, req),
      });
    })();
    return { ok: true };
  });

  /** すべての案件へのアクセス停止（セッション破棄・招待失効） */
  app.post('/api/app/clients/:id/suspend-access', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const c = ownedClient(db, op.id, id);
    const now = nowIso();
    db.transaction(() => {
      db.prepare(`UPDATE portal_access SET status = 'revoked', revoked_at = ? WHERE client_id = ? AND status = 'active'`).run(now, c.id);
      db.prepare(
        `UPDATE invites SET revoked_at = ? WHERE revoked_at IS NULL AND access_id IN (SELECT id FROM portal_access WHERE client_id = ?)`,
      ).run(now, c.id);
      db.prepare('DELETE FROM client_sessions WHERE client_id = ?').run(c.id);
      audit(db, {
        ownerId: op.id,
        actor: { type: 'operator', id: op.id, name: op.name },
        action: 'access.suspended_all',
        targetType: 'client',
        targetId: c.id,
        summary: `${c.company_name} の全案件アクセスを停止`,
        ...reqMeta(ctx, req),
      });
    })();
    return { ok: true };
  });

  app.delete('/api/app/clients/:id', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const c = ownedClient(db, op.id, id);
    const n = (db.prepare('SELECT COUNT(*) n FROM projects WHERE client_id = ?').get(c.id) as { n: number }).n;
    if (n > 0) throw conflict('案件がある顧客は削除できません。アーカイブするか、先に案件を削除してください', 'has_projects');
    db.transaction(() => {
      db.prepare('DELETE FROM client_sessions WHERE client_id = ?').run(c.id);
      db.prepare('DELETE FROM notifications WHERE recipient_type = ? AND recipient_id = ?').run('client', c.id);
      db.prepare('DELETE FROM clients WHERE id = ?').run(c.id);
      audit(db, {
        ownerId: op.id,
        actor: { type: 'operator', id: op.id, name: op.name },
        action: 'client.deleted',
        targetType: 'client',
        targetId: c.id,
        ...reqMeta(ctx, req),
      });
    })();
    return { ok: true };
  });
}

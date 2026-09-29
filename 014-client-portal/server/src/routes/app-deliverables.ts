import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOperator } from '../auth.js';
import { ownedProject, projectDeliverable, projectVersion } from '../access.js';
import { audit } from '../audit.js';
import { conflict, newId, nowIso, patchSchema } from '../util.js';
import { reqMeta } from './auth.js';
import { opActor } from './app-projects.js';
import { deliverableDto } from '../services/dto.js';
import { createComment, deleteComment, editComment, listComments, resolveComment, revokeApproval } from '../services/review.js';

const deliverableBody = z.object({
  title: z.string().trim().min(1, '制作物名を入力してください').max(120),
  category: z.string().trim().max(60).default(''),
  description: z.string().max(3000).default(''),
});

export const commentBody = z.object({
  body: z.string().max(4000),
  pin: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable().optional(),
  parentId: z.string().max(40).nullable().optional(),
});

export async function deliverableRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.post('/api/app/projects/:id/deliverables', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const b = deliverableBody.parse(req.body);
    const did = newId('dlv');
    const now = nowIso();
    const max = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM deliverables WHERE project_id = ?').get(p.id) as { m: number }).m;
    db.transaction(() => {
      db.prepare('INSERT INTO deliverables (id, project_id, title, category, description, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        did,
        p.id,
        b.title,
        b.category,
        b.description,
        max + 1,
        now,
        now,
      );
      audit(db, { ownerId: op.id, projectId: p.id, actor: opActor(op), action: 'deliverable.created', targetType: 'deliverable', targetId: did, summary: b.title, ...reqMeta(ctx, req) });
    })();
    return { id: did };
  });

  app.get('/api/app/projects/:id/deliverables/:did', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, did } = req.params as { id: string; did: string };
    const p = ownedProject(db, op.id, id);
    const d = projectDeliverable(db, p.id, did);
    const dto = deliverableDto(db, d, 'operator');
    const viewer = { type: 'operator', id: op.id };
    const comments = Object.fromEntries(dto.versions.map((v) => [v.id, listComments(ctx, v.id, viewer)]));
    return { projectName: p.name, deliverable: dto, comments, checklistTemplate: JSON.parse(p.checklist_json) };
  });

  app.patch('/api/app/projects/:id/deliverables/:did', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, did } = req.params as { id: string; did: string };
    const p = ownedProject(db, op.id, id);
    const d = projectDeliverable(db, p.id, did);
    const b = patchSchema(deliverableBody).parse(req.body);
    db.prepare('UPDATE deliverables SET title = ?, category = ?, description = ?, updated_at = ? WHERE id = ?').run(
      b.title ?? d.title,
      b.category ?? d.category,
      b.description ?? d.description,
      nowIso(),
      d.id,
    );
    return { ok: true };
  });

  app.delete('/api/app/projects/:id/deliverables/:did', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, did } = req.params as { id: string; did: string };
    const p = ownedProject(db, op.id, id);
    const d = projectDeliverable(db, p.id, did);
    const has = db.prepare('SELECT 1 FROM deliverable_versions WHERE deliverable_id = ?').get(d.id);
    if (has) throw conflict('提出済みの版がある制作物は削除できません（履歴保持のため）');
    db.transaction(() => {
      db.prepare('DELETE FROM deliverables WHERE id = ?').run(d.id);
      audit(db, { ownerId: op.id, projectId: p.id, actor: opActor(op), action: 'deliverable.deleted', targetType: 'deliverable', targetId: d.id, summary: d.title, ...reqMeta(ctx, req) });
    })();
    return { ok: true };
  });

  app.post('/api/app/projects/:id/versions/:vid/comments', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, vid } = req.params as { id: string; vid: string };
    const p = ownedProject(db, op.id, id);
    projectVersion(db, p.id, vid);
    const b = commentBody.parse(req.body);
    return createComment(ctx, p, { ...opActor(op), type: 'operator' }, vid, b, reqMeta(ctx, req));
  });

  app.patch('/api/app/projects/:id/comments/:cid', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, cid } = req.params as { id: string; cid: string };
    const p = ownedProject(db, op.id, id);
    const b = z.object({ body: z.string().max(4000) }).parse(req.body);
    editComment(ctx, p, cid, opActor(op), b.body, reqMeta(ctx, req));
    return { ok: true };
  });

  app.delete('/api/app/projects/:id/comments/:cid', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, cid } = req.params as { id: string; cid: string };
    const p = ownedProject(db, op.id, id);
    deleteComment(ctx, p, cid, opActor(op), reqMeta(ctx, req));
    return { ok: true };
  });

  app.post('/api/app/projects/:id/comments/:cid/resolve', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, cid } = req.params as { id: string; cid: string };
    const p = ownedProject(db, op.id, id);
    const b = z.object({ resolved: z.boolean() }).parse(req.body);
    resolveComment(ctx, p, cid, opActor(op), b.resolved, reqMeta(ctx, req));
    return { ok: true };
  });

  app.post('/api/app/projects/:id/approvals/:aid/revoke', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, aid } = req.params as { id: string; aid: string };
    const p = ownedProject(db, op.id, id);
    const b = z.object({ reason: z.string().max(1000) }).parse(req.body);
    revokeApproval(ctx, p, aid, opActor(op), b.reason, reqMeta(ctx, req));
    return { ok: true };
  });
}

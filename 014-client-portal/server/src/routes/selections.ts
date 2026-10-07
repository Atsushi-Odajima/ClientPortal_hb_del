import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireClient, requireOperator } from '../auth.js';
import { clientProject, ownedProject } from '../access.js';
import type { Ctx } from '../context.js';
import { contentDisposition, patchSchema } from '../util.js';
import { reqMeta } from './auth.js';
import { opActor } from './app-projects.js';
import {
  clientSelection,
  createSelection,
  deletePhotos,
  deleteSelection,
  exportSelection,
  movePhoto,
  projectSelection,
  savePicks,
  selectionDetailForClient,
  selectionDetailForOperator,
  selectionSummaryDto,
  setSelectionStatus,
  sortPhotosByName,
  submitPicks,
  updateSelection,
  type SelectionSetRow,
} from '../services/selection.js';

/**
 * Client Portal 写真セレクト API
 *   運営者: /api/app/projects/:id/selections…（運営者Cookie + 自分の案件）
 *   顧客:   /api/portal/projects/:id/selections…（顧客Cookie + 有効なアクセス権 + 公開済みセットのみ）
 * 写真のアップロードは既存の分割アップロード（target.purpose = 'selection_photo'）を使う。
 */

const setBody = z.object({
  title: z.string().trim().min(1, 'セレクト名を入力してください').max(120),
  message: z.string().max(3000).default(''),
  showNames: z.boolean().default(true),
});

export async function selectionRoutes(app: FastifyInstance) {
  const ctx: Ctx = app.ctx;
  const { db } = ctx;

  function opLoad(req: FastifyRequest) {
    const op = requireOperator(ctx, req);
    const { id, sid } = req.params as { id: string; sid?: string };
    const p = ownedProject(db, op.id, id);
    const s = sid ? projectSelection(db, p.id, sid) : null;
    return { op, p, s: s as SelectionSetRow, actor: opActor(op), meta: reqMeta(ctx, req) };
  }

  function clLoad(req: FastifyRequest) {
    const c = requireClient(ctx, req);
    const { id, sid } = req.params as { id: string; sid?: string };
    const p = clientProject(db, c, id);
    const s = sid ? clientSelection(db, p.id, sid) : null;
    return { c, p, s: s as SelectionSetRow, meta: reqMeta(ctx, req) };
  }

  // ---- 運営者 ----

  app.get('/api/app/projects/:id/selections', async (req) => {
    const { p } = opLoad(req);
    const rows = db.prepare('SELECT * FROM selection_sets WHERE project_id = ? ORDER BY created_at DESC').all(p.id) as SelectionSetRow[];
    return { selections: rows.map((s) => selectionSummaryDto(db, s, 'operator')) };
  });

  app.post('/api/app/projects/:id/selections', async (req) => {
    const { p, actor, meta } = opLoad(req);
    const b = setBody.parse(req.body);
    return createSelection(ctx, p, actor, b, meta);
  });

  app.get('/api/app/projects/:id/selections/:sid', async (req) => {
    const { p, s } = opLoad(req);
    return selectionDetailForOperator(db, p, s);
  });

  app.patch('/api/app/projects/:id/selections/:sid', async (req) => {
    const { s } = opLoad(req);
    updateSelection(ctx, s, patchSchema(setBody).parse(req.body));
    return { ok: true };
  });

  app.delete('/api/app/projects/:id/selections/:sid', async (req) => {
    const { p, s, actor, meta } = opLoad(req);
    await deleteSelection(ctx, p, s, actor, meta);
    return { ok: true };
  });

  app.post('/api/app/projects/:id/selections/:sid/status', async (req) => {
    const { p, s, actor, meta } = opLoad(req);
    const b = z.object({ status: z.enum(['open', 'closed']) }).parse(req.body);
    setSelectionStatus(ctx, p, s, b.status, actor, meta);
    return { ok: true };
  });

  app.post('/api/app/projects/:id/selections/:sid/photos/:phid/move', async (req) => {
    const { s } = opLoad(req);
    const { phid } = req.params as { phid: string };
    const b = z.object({ toNumber: z.number().int().min(1).max(10000) }).parse(req.body);
    movePhoto(ctx, s, phid, b.toNumber);
    return { ok: true };
  });

  app.post('/api/app/projects/:id/selections/:sid/sort-by-name', async (req) => {
    const { s } = opLoad(req);
    sortPhotosByName(ctx, s);
    return { ok: true };
  });

  app.post('/api/app/projects/:id/selections/:sid/photos/delete', async (req) => {
    const { p, s, actor, meta } = opLoad(req);
    const b = z.object({ photoIds: z.array(z.string().max(40)).min(1).max(300) }).parse(req.body);
    await deletePhotos(ctx, p, s, b.photoIds, actor, meta);
    return { ok: true };
  });

  app.get('/api/app/projects/:id/selections/:sid/export', async (req, reply) => {
    const { s } = opLoad(req);
    const q = z
      .object({ kind: z.enum(['map', 'picks']).default('picks'), format: z.enum(['csv', 'txt']).default('csv'), clientId: z.string().max(40).optional() })
      .parse(req.query);
    const out = exportSelection(db, s, q.kind, q.format, q.clientId);
    reply.header('Content-Type', q.format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', contentDisposition('attachment', out.filename));
    reply.header('Cache-Control', 'no-store');
    return reply.send(out.body);
  });

  // ---- 顧客 ----

  app.get('/api/portal/projects/:id/selections', async (req) => {
    const { c, p } = clLoad(req);
    const rows = db
      .prepare(`SELECT * FROM selection_sets WHERE project_id = ? AND status IN ('open','closed') ORDER BY opened_at DESC, created_at DESC`)
      .all(p.id) as SelectionSetRow[];
    return { selections: rows.map((s) => selectionSummaryDto(db, s, 'client', c.id)) };
  });

  app.get('/api/portal/projects/:id/selections/:sid', async (req) => {
    const { c, s } = clLoad(req);
    return selectionDetailForClient(db, s, c);
  });

  app.post('/api/portal/projects/:id/selections/:sid/picks', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) => {
    const { c, s } = clLoad(req);
    const b = z
      .object({
        photoIds: z.array(z.string().max(40)).max(300).optional(),
        numbersText: z.string().max(20000).optional(),
        mode: z.enum(['add', 'replace']).default('add'),
      })
      .parse(req.body);
    return savePicks(ctx, s, c, b);
  });

  app.post('/api/portal/projects/:id/selections/:sid/submit', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { c, p, s, meta } = clLoad(req);
    const b = z.object({ note: z.string().max(2000).default('') }).parse(req.body ?? {});
    return submitPicks(ctx, p, s, c, b.note, meta);
  });
}

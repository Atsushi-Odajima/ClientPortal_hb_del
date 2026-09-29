import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOperator } from '../auth.js';
import { latestVersion, ownedProject } from '../access.js';
import { audit } from '../audit.js';
import type { Ctx, DeliveryRow, ProjectRow, VersionRow } from '../context.js';
import { badRequest, conflict, newId, notFound, nowIso, patchSchema, safeFileName } from '../util.js';
import { reqMeta } from './auth.js';
import { opActor } from './app-projects.js';
import { deliveryDto } from '../services/dto.js';
import { notifyProjectClients } from '../notify.js';
import { autoTransition } from '../services/projectState.js';
import { assertZipSize, buildZipEntries, streamZip } from '../services/zip.js';

const deliveryBody = z.object({
  title: z.string().trim().min(1, 'タイトルを入力してください').max(120),
  description: z.string().max(3000).default(''),
  notice: z.string().max(3000).default(''),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  versionIds: z.array(z.string().max(40)).max(200).default([]),
});

/** 納品に含められるのは「最新版かつ有効な承認がある版」のみ */
export function assertDeliverableVersion(ctx: Ctx, projectId: string, versionId: string): { version: VersionRow; approvalId: string } {
  const v = ctx.db.prepare('SELECT * FROM deliverable_versions WHERE id = ? AND project_id = ?').get(versionId, projectId) as VersionRow | undefined;
  if (!v) throw notFound('バージョン');
  const latest = latestVersion(ctx.db, v.deliverable_id)!;
  const approval = ctx.db.prepare('SELECT id FROM approvals WHERE version_id = ? AND revoked_at IS NULL').get(v.id) as { id: string } | undefined;
  if (latest.id !== v.id || v.status !== 'approved' || !approval) {
    throw conflict('承認済みの最新版のみ納品に含められます', 'not_approved', { versionId });
  }
  return { version: v, approvalId: approval.id };
}

export function ownedDelivery(ctx: Ctx, p: ProjectRow, deliveryId: string): DeliveryRow {
  const d = ctx.db.prepare('SELECT * FROM deliveries WHERE id = ? AND project_id = ?').get(deliveryId, p.id) as DeliveryRow | undefined;
  if (!d) throw notFound('納品');
  return d;
}

export async function deliveryRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.get('/api/app/projects/:id/delivery-candidates', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const rows = db
      .prepare(
        `SELECT d.id deliverable_id, d.title, dv.id version_id, dv.version_number, dv.status, f.original_name, f.size,
                (SELECT approved_at FROM approvals a WHERE a.version_id = dv.id AND a.revoked_at IS NULL) approved_at
         FROM deliverables d
         JOIN deliverable_versions dv ON dv.deliverable_id = d.id
           AND dv.version_number = (SELECT MAX(version_number) FROM deliverable_versions WHERE deliverable_id = d.id)
         JOIN files f ON f.id = dv.file_id
         WHERE d.project_id = ? ORDER BY d.sort_order`,
      )
      .all(p.id) as { deliverable_id: string; title: string; version_id: string; version_number: number; status: string; original_name: string; size: number; approved_at: string | null }[];
    return {
      candidates: rows.map((r) => ({
        deliverableId: r.deliverable_id,
        title: r.title,
        versionId: r.version_id,
        versionNumber: r.version_number,
        fileName: r.original_name,
        size: r.size,
        approved: r.status === 'approved' && !!r.approved_at,
        approvedAt: r.approved_at,
        status: r.status,
      })),
    };
  });

  app.post('/api/app/projects/:id/deliveries', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const b = deliveryBody.parse(req.body);
    const did = newId('dly');
    const now = nowIso();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO deliveries (id, project_id, title, description, notice, expires_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      ).run(did, p.id, b.title, b.description, b.notice, b.expiresAt ?? null, now, now);
      const unique = [...new Set(b.versionIds)];
      unique.forEach((vid, i) => {
        const { version, approvalId } = assertDeliverableVersion(ctx, p.id, vid);
        db.prepare('INSERT INTO delivery_items (id, delivery_id, version_id, approval_id, file_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(
          newId('dli'),
          did,
          version.id,
          approvalId,
          version.file_id,
          i,
        );
      });
      audit(db, { ownerId: op.id, projectId: p.id, actor: opActor(op), action: 'delivery.created', targetType: 'delivery', targetId: did, summary: b.title, ...reqMeta(ctx, req) });
    })();
    return { id: did };
  });

  app.patch('/api/app/projects/:id/deliveries/:did', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, did } = req.params as { id: string; did: string };
    const p = ownedProject(db, op.id, id);
    const d = ownedDelivery(ctx, p, did);
    const b = patchSchema(deliveryBody).parse(req.body);
    if (d.status !== 'draft' && (b.versionIds || b.title)) throw conflict('公開後は内容を変更できません。取り下げて新しい納品を作成してください');
    db.transaction(() => {
      db.prepare('UPDATE deliveries SET title = ?, description = ?, notice = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(
        b.title ?? d.title,
        b.description ?? d.description,
        b.notice ?? d.notice,
        b.expiresAt === undefined ? d.expires_at : b.expiresAt,
        nowIso(),
        d.id,
      );
      if (b.versionIds) {
        db.prepare('DELETE FROM delivery_items WHERE delivery_id = ? AND version_id IS NOT NULL').run(d.id);
        [...new Set(b.versionIds)].forEach((vid, i) => {
          const { version, approvalId } = assertDeliverableVersion(ctx, p.id, vid);
          db.prepare('INSERT INTO delivery_items (id, delivery_id, version_id, approval_id, file_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(
            newId('dli'),
            d.id,
            version.id,
            approvalId,
            version.file_id,
            i,
          );
        });
      }
      if (b.expiresAt !== undefined && d.status === 'published') {
        audit(db, { ownerId: op.id, projectId: p.id, actor: opActor(op), action: 'delivery.expiry_changed', targetType: 'delivery', targetId: d.id, detail: { expiresAt: b.expiresAt }, ...reqMeta(ctx, req) });
      }
    })();
    return { ok: true };
  });

  app.delete('/api/app/projects/:id/deliveries/:did/items/:itemId', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, did, itemId } = req.params as { id: string; did: string; itemId: string };
    const p = ownedProject(db, op.id, id);
    const d = ownedDelivery(ctx, p, did);
    if (d.status !== 'draft') throw conflict('公開後は内容を変更できません');
    const r = db.prepare('DELETE FROM delivery_items WHERE id = ? AND delivery_id = ?').run(itemId, d.id);
    if (r.changes === 0) throw notFound('項目');
    return { ok: true };
  });

  app.post('/api/app/projects/:id/deliveries/:did/publish', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, did } = req.params as { id: string; did: string };
    const p = ownedProject(db, op.id, id);
    const d = ownedDelivery(ctx, p, did);
    const { confirm } = z.object({ confirm: z.literal(true) }).parse(req.body);
    void confirm;
    if (d.status !== 'draft') throw conflict('下書きの納品のみ公開できます');
    db.transaction(() => {
      const items = db.prepare('SELECT * FROM delivery_items WHERE delivery_id = ?').all(d.id) as { id: string; version_id: string | null; approval_id: string | null }[];
      if (items.length === 0) throw badRequest('納品するファイルがありません');
      // 公開直前に承認状態を再検証
      for (const it of items) {
        if (it.version_id) {
          const { approvalId } = assertDeliverableVersion(ctx, p.id, it.version_id);
          if (approvalId !== it.approval_id) db.prepare('UPDATE delivery_items SET approval_id = ? WHERE id = ?').run(approvalId, it.id);
        }
      }
      if (d.expires_at && Date.parse(d.expires_at) < Date.now()) throw badRequest('ダウンロード期限が過去の日時です');
      const now = nowIso();
      db.prepare(`UPDATE deliveries SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?`).run(now, now, d.id);
      audit(db, {
        ownerId: op.id,
        projectId: p.id,
        actor: opActor(op),
        action: 'delivery.published',
        targetType: 'delivery',
        targetId: d.id,
        summary: `納品「${d.title}」を公開（${items.length}件）`,
        clientVisible: true,
        ...reqMeta(ctx, req),
      });
      notifyProjectClients(ctx, p.id, {
        ownerId: op.id,
        kind: 'delivery_published',
        title: `納品物をお受け取りください: ${d.title}`,
        link: `/portal/p/${p.id}/deliveries`,
        dedupeKey: `dly:${d.id}`,
      });
      autoTransition(ctx, p.id, 'delivery_published');
    })();
    return { ok: true };
  });

  app.post('/api/app/projects/:id/deliveries/:did/withdraw', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, did } = req.params as { id: string; did: string };
    const p = ownedProject(db, op.id, id);
    const d = ownedDelivery(ctx, p, did);
    if (d.status !== 'published') throw conflict('公開中の納品のみ取り下げできます');
    db.transaction(() => {
      db.prepare(`UPDATE deliveries SET status = 'withdrawn', updated_at = ? WHERE id = ?`).run(nowIso(), d.id);
      audit(db, {
        ownerId: op.id,
        projectId: p.id,
        actor: opActor(op),
        action: 'delivery.withdrawn',
        targetType: 'delivery',
        targetId: d.id,
        summary: `納品「${d.title}」を取り下げ`,
        clientVisible: true,
        ...reqMeta(ctx, req),
      });
    })();
    return { ok: true };
  });

  app.delete('/api/app/projects/:id/deliveries/:did', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, did } = req.params as { id: string; did: string };
    const p = ownedProject(db, op.id, id);
    const d = ownedDelivery(ctx, p, did);
    if (d.status !== 'draft') throw conflict('下書きのみ削除できます（公開済みは取り下げてください）');
    db.transaction(() => {
      db.prepare('DELETE FROM delivery_items WHERE delivery_id = ?').run(d.id);
      db.prepare('DELETE FROM deliveries WHERE id = ?').run(d.id);
    })();
    return { ok: true };
  });

  app.get('/api/app/projects/:id/deliveries/:did', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, did } = req.params as { id: string; did: string };
    const p = ownedProject(db, op.id, id);
    return { delivery: deliveryDto(db, ownedDelivery(ctx, p, did), 'operator') };
  });

  app.get('/api/app/projects/:id/deliveries/:did/zip', async (req, reply) => {
    const op = requireOperator(ctx, req);
    const { id, did } = req.params as { id: string; did: string };
    const p = ownedProject(db, op.id, id);
    const d = ownedDelivery(ctx, p, did);
    const entries = buildZipEntries(ctx, d);
    assertZipSize(ctx, entries);
    await streamZip(ctx, reply, `${safeFileName(d.title, 'delivery')}.zip`, entries);
    return reply;
  });
}

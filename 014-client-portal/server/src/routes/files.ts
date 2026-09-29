import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireClient, requireOperator, resolveClient, resolveOperator } from '../auth.js';
import { assertClientCanReadFile, clientProject, ownedProject, projectDeliverable, projectFile } from '../access.js';
import { audit } from '../audit.js';
import type { Actor, Ctx, DeliverableRow, DeliveryRow, FileRow, ProjectRow, RequestRow } from '../context.js';
import { HttpError, addDays, badRequest, conflict, contentDisposition, newId, notFound, nowIso } from '../util.js';
import { inspectFile, precheck } from '../fileTypes.js';
import { objectKey } from '../storage/index.js';
import { reqMeta } from './auth.js';
import { fileDto } from '../services/dto.js';
import { insertVersion } from '../services/review.js';

type Target =
  | { purpose: 'request_attachment'; requestId: string }
  | { purpose: 'deliverable_version'; deliverableId: string; note: string; checklist: string[]; reviewDueDate: string | null }
  | { purpose: 'delivery_extra'; deliveryId: string }
  | { purpose: 'internal' };

const initBase = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().min(0),
  mime: z.string().max(200).default(''),
});

const operatorTarget = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('request_attachment'), requestId: z.string().max(40) }),
  z.object({
    purpose: z.literal('deliverable_version'),
    deliverableId: z.string().max(40),
    note: z.string().max(3000).default(''),
    checklist: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    reviewDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  }),
  z.object({ purpose: z.literal('delivery_extra'), deliveryId: z.string().max(40) }),
  z.object({ purpose: z.literal('internal') }),
]);

interface UploadRow {
  id: string;
  owner_id: string;
  project_id: string;
  actor_type: 'operator' | 'client';
  actor_id: string;
  original_name: string;
  declared_mime: string;
  size: number;
  chunk_size: number;
  chunk_count: number;
  received_json: string;
  target_json: string;
  status: string;
  error_code: string;
  file_id: string | null;
  created_at: string;
  expires_at: string;
}

export function tmpUploadDir(ctx: Ctx, uploadId: string): string {
  if (!/^upl_[A-Za-z0-9]+$/.test(uploadId)) throw notFound('アップロード');
  return path.join(ctx.cfg.dataDir, 'tmp', 'uploads', uploadId);
}

function projectUsage(ctx: Ctx, projectId: string): number {
  return (ctx.db.prepare(`SELECT COALESCE(SUM(size), 0) s FROM files WHERE project_id = ?`).get(projectId) as { s: number }).s;
}

/** 提出先（target）がまだ受付可能か検証 */
function validateTarget(ctx: Ctx, p: ProjectRow, actorType: 'operator' | 'client', t: Target): void {
  const { db } = ctx;
  switch (t.purpose) {
    case 'request_attachment': {
      const r = db.prepare('SELECT * FROM document_requests WHERE id = ? AND project_id = ?').get(t.requestId, p.id) as RequestRow | undefined;
      if (!r) throw notFound('資料リクエスト');
      if (actorType === 'client') {
        if (r.kind !== 'file') throw badRequest('この項目はファイル提出ではありません');
        if (r.status !== 'pending' && r.status !== 'returned') throw conflict('提出済みの項目です。差戻しがあった場合のみ再提出できます', 'request_locked');
      }
      return;
    }
    case 'deliverable_version':
      if (actorType !== 'operator') throw new HttpError(403, 'forbidden', '許可されていません');
      projectDeliverable(db, p.id, t.deliverableId);
      return;
    case 'delivery_extra': {
      if (actorType !== 'operator') throw new HttpError(403, 'forbidden', '許可されていません');
      const d = db.prepare('SELECT * FROM deliveries WHERE id = ? AND project_id = ?').get(t.deliveryId, p.id) as DeliveryRow | undefined;
      if (!d) throw notFound('納品');
      if (d.status !== 'draft') throw conflict('公開後の納品にはファイルを追加できません');
      return;
    }
    case 'internal':
      if (actorType !== 'operator') throw new HttpError(403, 'forbidden', '許可されていません');
      return;
  }
}

function initUpload(ctx: Ctx, p: ProjectRow, actor: Actor & { type: 'operator' | 'client' }, body: z.infer<typeof initBase>, target: Target) {
  const { cfg, db } = ctx;
  const err = precheck(body.name, body.size, cfg.limits.maxUploadBytes);
  if (err) throw badRequest(err.message, err.code);
  if (cfg.limits.maxProjectStorageBytes > 0 && projectUsage(ctx, p.id) + body.size > cfg.limits.maxProjectStorageBytes) {
    throw badRequest('この案件の保存容量の上限に達しています', 'quota_exceeded');
  }
  validateTarget(ctx, p, actor.type, target);
  const id = newId('upl');
  const chunkSize = cfg.limits.chunkBytes;
  const chunkCount = Math.max(1, Math.ceil(body.size / chunkSize));
  db.prepare(
    `INSERT INTO uploads (id, owner_id, project_id, actor_type, actor_id, original_name, declared_mime, size, chunk_size, chunk_count, target_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, p.owner_id, p.id, actor.type, actor.id, body.name.normalize('NFC'), body.mime, body.size, chunkSize, chunkCount, JSON.stringify(target), nowIso(), addDays(new Date(), 1).toISOString());
  return { uploadId: id, chunkSize, chunkCount };
}

/** アップロード操作者の再認証（アップロード中にアクセス停止された場合も拒否） */
function loadUploadForActor(ctx: Ctx, req: FastifyRequest, uploadId: string): { upload: UploadRow; project: ProjectRow; actor: Actor & { type: 'operator' | 'client' } } {
  const up = ctx.db.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId) as UploadRow | undefined;
  if (!up) throw notFound('アップロード');
  if (up.actor_type === 'operator') {
    const op = resolveOperator(ctx, req);
    if (!op || op.id !== up.actor_id) throw notFound('アップロード');
    return { upload: up, project: ownedProject(ctx.db, op.id, up.project_id), actor: { type: 'operator', id: op.id, name: op.name } };
  }
  const c = resolveClient(ctx, req);
  if (!c || c.id !== up.actor_id) throw notFound('アップロード');
  return { upload: up, project: clientProject(ctx.db, c, up.project_id), actor: { type: 'client', id: c.id, name: c.contact_name || c.company_name } };
}

function uploadStatusDto(up: UploadRow) {
  return {
    uploadId: up.id,
    status: up.status,
    chunkSize: up.chunk_size,
    chunkCount: up.chunk_count,
    received: JSON.parse(up.received_json) as number[],
    fileId: up.file_id,
    errorCode: up.error_code,
  };
}

async function assemble(dir: string, count: number, out: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const ws = fs.createWriteStream(out);
  try {
    for (let i = 0; i < count; i++) {
      const buf = await fsp.readFile(path.join(dir, `${i}.part`));
      hash.update(buf);
      if (!ws.write(buf)) await new Promise((r) => ws.once('drain', r));
    }
  } finally {
    await new Promise<void>((resolve, reject) => ws.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
  return hash.digest('hex');
}

async function completeUpload(ctx: Ctx, up: UploadRow, p: ProjectRow, actor: Actor & { type: 'operator' | 'client' }, meta: { ipHash: string; userAgent: string }) {
  const { db, storage } = ctx;
  const target = JSON.parse(up.target_json) as Target;
  const dir = tmpUploadDir(ctx, up.id);
  const received = new Set(JSON.parse(up.received_json) as number[]);
  for (let i = 0; i < up.chunk_count; i++) if (!received.has(i)) throw conflict(`未受信のデータがあります（${i + 1}/${up.chunk_count}）`, 'incomplete', { missing: i });
  // 同時完了を防ぐ
  const lock = db.prepare(`UPDATE uploads SET status = 'completing' WHERE id = ? AND status = 'uploading'`).run(up.id);
  if (lock.changes === 0) throw conflict('このアップロードは処理中です', 'in_progress');
  const assembled = path.join(dir, 'assembled');
  let key: string | null = null;
  let stored = false;
  try {
    const sha256 = await assemble(dir, up.chunk_count, assembled);
    const st = await fsp.stat(assembled);
    if (st.size !== up.size) throw badRequest('受信したサイズが一致しません。もう一度お試しください', 'size_mismatch');
    const check = await inspectFile(assembled, up.original_name);
    if (!check.ok) {
      db.prepare(`UPDATE uploads SET status = 'failed', error_code = ? WHERE id = ?`).run(check.code, up.id);
      await fsp.rm(dir, { recursive: true, force: true });
      throw badRequest(check.message, check.code);
    }
    validateTarget(ctx, p, actor.type, target);
    const fileId = newId('fil');
    key = objectKey(p.id, fileId);
    // 1) ストレージ保存が成功してから 2) DBへ記録。DB失敗時は実体を削除（提出済みレコードだけ残ることはない）
    await storage.putFile(key, assembled, check.mime);
    stored = true;
    const result = db.transaction(() => {
      let versionGroupId: string | null = null;
      let versionNumber: number | null = null;
      let deliverable: DeliverableRow | null = null;
      if (target.purpose === 'deliverable_version') {
        deliverable = projectDeliverable(db, p.id, target.deliverableId);
        versionGroupId = deliverable.id;
        versionNumber =
          ((db.prepare('SELECT COALESCE(MAX(version_number), 0) m FROM deliverable_versions WHERE deliverable_id = ?').get(deliverable.id) as { m: number }).m ?? 0) + 1;
      }
      db.prepare(
        `INSERT INTO files (id, project_id, owner_id, uploader_type, uploader_id, original_name, storage_key, mime, size, sha256, purpose, request_id,
          version_group_id, version_number, preview_kind, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        fileId,
        p.id,
        p.owner_id,
        actor.type,
        actor.id,
        up.original_name,
        key,
        check.mime,
        st.size,
        sha256,
        target.purpose,
        target.purpose === 'request_attachment' ? target.requestId : null,
        versionGroupId,
        versionNumber,
        check.previewKind,
        check.width ?? null,
        check.height ?? null,
        nowIso(),
      );
      const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow;
      let versionId: string | null = null;
      if (target.purpose === 'deliverable_version' && deliverable) {
        versionId = insertVersion(ctx, p, deliverable, file, actor, { note: target.note, checklist: target.checklist, reviewDueDate: target.reviewDueDate }).id;
      } else if (target.purpose === 'delivery_extra') {
        const max = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM delivery_items WHERE delivery_id = ?').get(target.deliveryId) as { m: number }).m;
        db.prepare('INSERT INTO delivery_items (id, delivery_id, file_id, label, sort_order) VALUES (?, ?, ?, ?, ?)').run(newId('dli'), target.deliveryId, fileId, up.original_name, max + 1);
      }
      if (target.purpose !== 'deliverable_version') {
        audit(db, {
          ownerId: p.owner_id,
          projectId: p.id,
          actor,
          action: 'file.uploaded',
          targetType: 'file',
          targetId: fileId,
          summary: `ファイル「${up.original_name}」をアップロード`,
          detail: { purpose: target.purpose, size: st.size, sha256, requestId: target.purpose === 'request_attachment' ? target.requestId : undefined },
          clientVisible: target.purpose === 'request_attachment',
          ...meta,
        });
      }
      db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), p.id);
      db.prepare(`UPDATE uploads SET status = 'completed', file_id = ? WHERE id = ?`).run(fileId, up.id);
      return { file, versionId };
    })();
    await fsp.rm(dir, { recursive: true, force: true });
    return { file: fileDto(result.file, actor.type), versionId: result.versionId };
  } catch (e) {
    if (stored && key) await storage.delete(key).catch(() => undefined);
    const cur = db.prepare('SELECT status FROM uploads WHERE id = ?').get(up.id) as { status: string } | undefined;
    // 一時的な失敗は再試行できるよう uploading に戻す（チャンクは保持）
    if (cur?.status === 'completing') db.prepare(`UPDATE uploads SET status = 'uploading' WHERE id = ?`).run(up.id);
    await fsp.rm(assembled, { force: true }).catch(() => undefined);
    throw e;
  }
}

const PREVIEW_CSP: Record<string, string> = {
  image: "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  video: "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  pdf: "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'",
  none: "default-src 'none'; sandbox",
};

/** ファイル配信。ダウンロード時は外部ストレージなら期限付きURLへリダイレクト、それ以外はアプリ経由（Range対応） */
export async function serveFile(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, file: FileRow, forceDownload: boolean): Promise<FastifyReply> {
  const inline = !forceDownload && file.preview_kind !== 'none';
  const disposition = inline ? 'inline' : 'attachment';
  if (!inline) {
    const signed = await ctx.storage.signedDownloadUrl(file.storage_key, {
      filename: file.original_name,
      disposition,
      contentType: file.mime,
      expiresSeconds: ctx.cfg.storage.signedUrlSeconds,
    });
    if (signed) {
      reply.header('Cache-Control', 'no-store');
      return reply.redirect(signed, 302);
    }
  }
  reply.header('Content-Type', inline ? file.mime : file.preview_kind === 'none' ? 'application/octet-stream' : file.mime);
  reply.header('Content-Disposition', contentDisposition(disposition, file.original_name));
  reply.header('Content-Security-Policy', PREVIEW_CSP[inline ? file.preview_kind : 'none']);
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  reply.header('Cache-Control', 'private, max-age=300');
  reply.header('Accept-Ranges', 'bytes');
  reply.header('ETag', `"${file.sha256.slice(0, 32)}"`);
  if (inline && req.headers['if-none-match'] === `"${file.sha256.slice(0, 32)}"`) return reply.status(304).send();
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) return reply.status(416).header('Content-Range', `bytes */${file.size}`).send();
    let start: number;
    let end: number;
    if (m[1] === '') {
      const suffix = Number(m[2]);
      start = Math.max(0, file.size - suffix);
      end = file.size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? file.size - 1 : Math.min(Number(m[2]), file.size - 1);
    }
    if (start > end || start >= file.size) return reply.status(416).header('Content-Range', `bytes */${file.size}`).send();
    const obj = await ctx.storage.get(file.storage_key, { start, end });
    reply.status(206).header('Content-Range', `bytes ${start}-${end}/${file.size}`).header('Content-Length', end - start + 1);
    return reply.send(obj.stream);
  }
  const obj = await ctx.storage.get(file.storage_key);
  reply.header('Content-Length', obj.size);
  return reply.send(obj.stream);
}

export async function fileRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.post('/api/app/projects/:id/uploads', async (req) => {
    const op = requireOperator(ctx, req);
    const { id } = req.params as { id: string };
    const p = ownedProject(db, op.id, id);
    const body = initBase.extend({ target: operatorTarget }).parse(req.body);
    return initUpload(ctx, p, { type: 'operator', id: op.id, name: op.name }, body, body.target as Target);
  });

  app.post('/api/portal/projects/:id/uploads', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const c = requireClient(ctx, req);
    const { id } = req.params as { id: string };
    const p = clientProject(db, c, id);
    const body = initBase.extend({ requestId: z.string().max(40) }).parse(req.body);
    return initUpload(ctx, p, { type: 'client', id: c.id, name: c.contact_name || c.company_name }, body, { purpose: 'request_attachment', requestId: body.requestId });
  });

  app.get('/api/uploads/:uid', async (req) => {
    const { uid } = req.params as { uid: string };
    const { upload } = loadUploadForActor(ctx, req, uid);
    return uploadStatusDto(upload);
  });

  app.put(
    '/api/uploads/:uid/chunks/:n',
    { bodyLimit: ctx.cfg.limits.chunkBytes + 1024 },
    async (req) => {
      const { uid, n } = req.params as { uid: string; n: string };
      const idx = Number(n);
      const { upload } = loadUploadForActor(ctx, req, uid);
      if (upload.status !== 'uploading') throw conflict('このアップロードは受付を終了しています', 'not_uploading');
      if (Date.parse(upload.expires_at) < Date.now()) throw conflict('アップロードの有効期限が切れました。最初からやり直してください', 'expired');
      if (!Number.isInteger(idx) || idx < 0 || idx >= upload.chunk_count) throw badRequest('チャンク番号が不正です');
      const expected = idx === upload.chunk_count - 1 ? upload.size - upload.chunk_size * (upload.chunk_count - 1) : upload.chunk_size;
      const dir = tmpUploadDir(ctx, upload.id);
      await fsp.mkdir(dir, { recursive: true });
      const partTmp = path.join(dir, `${idx}.part.tmp-${Date.now()}`);
      const stream = req.body as Readable;
      if (!stream || typeof (stream as Readable).pipe !== 'function') throw badRequest('Content-Type: application/octet-stream で送信してください');
      let written = 0;
      stream.on('data', (c: Buffer) => {
        written += c.length;
        // 宣言サイズを超えるデータはディスクに書き込む前に打ち切る
        if (written > expected) stream.destroy(new Error('chunk too large'));
      });
      try {
        await pipeline(stream, fs.createWriteStream(partTmp));
      } catch {
        await fsp.rm(partTmp, { force: true });
        if (written > expected) throw badRequest(`チャンクサイズが不正です（${written}/${expected}）`, 'chunk_size');
        throw badRequest('データの受信に失敗しました。再試行してください', 'chunk_failed');
      }
      if (written !== expected) {
        await fsp.rm(partTmp, { force: true });
        throw badRequest(`チャンクサイズが不正です（${written}/${expected}）`, 'chunk_size');
      }
      await fsp.rename(partTmp, path.join(dir, `${idx}.part`));
      // 受信済み一覧を更新（再送は上書き＝冪等）
      const received = db.transaction(() => {
        const cur = db.prepare('SELECT received_json FROM uploads WHERE id = ?').get(upload.id) as { received_json: string };
        const set = new Set(JSON.parse(cur.received_json) as number[]);
        set.add(idx);
        const arr = [...set].sort((a, b) => a - b);
        db.prepare('UPDATE uploads SET received_json = ? WHERE id = ?').run(JSON.stringify(arr), upload.id);
        return arr;
      })();
      return { received: received.length, chunkCount: upload.chunk_count };
    },
  );

  app.post('/api/uploads/:uid/complete', async (req) => {
    const { uid } = req.params as { uid: string };
    const { upload, project, actor } = loadUploadForActor(ctx, req, uid);
    if (upload.status === 'completed' && upload.file_id) {
      // 完了済みへの再送（通信断後の再試行）は同じ結果を返す
      const f = db.prepare('SELECT * FROM files WHERE id = ?').get(upload.file_id) as FileRow;
      const v = db.prepare('SELECT id FROM deliverable_versions WHERE file_id = ?').get(f.id) as { id: string } | undefined;
      return { file: fileDto(f, actor.type), versionId: v?.id ?? null, duplicate: true };
    }
    if (upload.status === 'failed') throw badRequest('このファイルは受け付けられませんでした', upload.error_code || 'failed');
    if (upload.status !== 'uploading') throw conflict('このアップロードは処理できません', 'not_uploading');
    return completeUpload(ctx, upload, project, actor, reqMeta(ctx, req));
  });

  app.delete('/api/uploads/:uid', async (req) => {
    const { uid } = req.params as { uid: string };
    const { upload } = loadUploadForActor(ctx, req, uid);
    if (upload.status === 'uploading') {
      db.prepare(`UPDATE uploads SET status = 'aborted' WHERE id = ?`).run(upload.id);
      await fsp.rm(tmpUploadDir(ctx, upload.id), { recursive: true, force: true });
    }
    return { ok: true };
  });

  // ---- ファイル取得 ----

  app.get('/api/app/projects/:id/files/:fid/content', async (req, reply) => {
    const op = requireOperator(ctx, req);
    const { id, fid } = req.params as { id: string; fid: string };
    const p = ownedProject(db, op.id, id);
    const f = projectFile(db, p.id, fid);
    const dl = (req.query as { dl?: string }).dl === '1';
    if (dl) {
      audit(db, {
        ownerId: op.id,
        projectId: p.id,
        actor: { type: 'operator', id: op.id, name: op.name },
        action: 'file.downloaded',
        targetType: 'file',
        targetId: f.id,
        summary: f.original_name,
        ...reqMeta(ctx, req),
      });
    }
    return serveFile(ctx, req, reply, f, dl);
  });

  app.get('/api/portal/projects/:id/files/:fid/content', async (req, reply) => {
    const c = requireClient(ctx, req);
    const { id, fid } = req.params as { id: string; fid: string };
    const p = clientProject(db, c, id);
    const f = projectFile(db, p.id, fid);
    const q = req.query as { dl?: string; delivery?: string };
    const dl = q.dl === '1';
    let deliveryId: string | null = null;
    if (q.delivery) {
      // 納品タブからの取得: 公開中・期限内の納品に含まれていることを確認
      const d = db
        .prepare(
          `SELECT d.id, d.expires_at FROM deliveries d JOIN delivery_items di ON di.delivery_id = d.id
           WHERE d.id = ? AND d.project_id = ? AND d.status = 'published' AND di.file_id = ?`,
        )
        .get(q.delivery, p.id, f.id) as { id: string; expires_at: string | null } | undefined;
      if (!d) throw notFound('ファイル');
      if (d.expires_at && Date.parse(d.expires_at) < Date.now()) throw new HttpError(410, 'expired', 'ダウンロード期限が過ぎています。担当者にご連絡ください');
      deliveryId = d.id;
    } else {
      assertClientCanReadFile(db, f);
    }
    if (dl) {
      audit(db, {
        ownerId: p.owner_id,
        projectId: p.id,
        actor: { type: 'client', id: c.id, name: c.contact_name || c.company_name },
        action: deliveryId ? 'delivery.downloaded' : 'file.downloaded',
        targetType: deliveryId ? 'delivery' : 'file',
        targetId: deliveryId ?? f.id,
        summary: `「${f.original_name}」をダウンロード`,
        detail: { fileId: f.id },
        clientVisible: !!deliveryId,
        ...reqMeta(ctx, req),
      });
    }
    return serveFile(ctx, req, reply, f, dl);
  });

  // 取り下げ: 顧客は提出前（未提出/差戻し）の自分のファイルのみ、運営者は内部ファイル・未提出の添付
  app.post('/api/portal/projects/:id/files/:fid/withdraw', async (req) => {
    const c = requireClient(ctx, req);
    const { id, fid } = req.params as { id: string; fid: string };
    const p = clientProject(db, c, id);
    const f = projectFile(db, p.id, fid);
    if (f.uploader_type !== 'client' || f.uploader_id !== c.id || f.purpose !== 'request_attachment' || f.status !== 'active') throw notFound('ファイル');
    const r = db.prepare('SELECT status FROM document_requests WHERE id = ?').get(f.request_id) as { status: string } | undefined;
    if (!r || (r.status !== 'pending' && r.status !== 'returned')) throw conflict('提出済みのファイルは取り下げできません');
    db.transaction(() => {
      db.prepare(`UPDATE files SET status = 'withdrawn' WHERE id = ?`).run(f.id);
      audit(db, {
        ownerId: p.owner_id,
        projectId: p.id,
        actor: { type: 'client', id: c.id, name: c.contact_name || c.company_name },
        action: 'file.withdrawn',
        targetType: 'file',
        targetId: f.id,
        summary: `「${f.original_name}」を取り下げ`,
        ...reqMeta(ctx, req),
      });
    })();
    return { ok: true };
  });

  app.post('/api/app/projects/:id/files/:fid/withdraw', async (req) => {
    const op = requireOperator(ctx, req);
    const { id, fid } = req.params as { id: string; fid: string };
    const p = ownedProject(db, op.id, id);
    const f = projectFile(db, p.id, fid);
    if (f.purpose === 'deliverable_version') throw conflict('提出済みの版のファイルは取り下げできません（履歴保持のため）。新しい版を提出してください');
    if (f.purpose === 'delivery_extra') {
      const pub = db.prepare(`SELECT 1 FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id WHERE di.file_id = ? AND d.status = 'published'`).get(f.id);
      if (pub) throw conflict('公開中の納品に含まれています');
      db.prepare('DELETE FROM delivery_items WHERE file_id = ?').run(f.id);
    }
    db.transaction(() => {
      db.prepare(`UPDATE files SET status = 'withdrawn' WHERE id = ?`).run(f.id);
      audit(db, { ownerId: op.id, projectId: p.id, actor: { type: 'operator', id: op.id, name: op.name }, action: 'file.withdrawn', targetType: 'file', targetId: f.id, summary: f.original_name, ...reqMeta(ctx, req) });
    })();
    return { ok: true };
  });
}

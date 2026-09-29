import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Actor, Ctx, FileRow, ProjectRow } from '../context.js';
import { inspectFile } from '../fileTypes.js';
import { objectKey } from '../storage/index.js';
import { HttpError, newId, nowIso } from '../util.js';

async function sha256File(p: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(p)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * サーバー内部からファイルを登録（サンプル作成・シード用）。
 * 通常のアップロードと同じ検証を通し、ストレージ保存 → DB記録の順で行う。
 */
export async function storeLocalFile(
  ctx: Ctx,
  p: ProjectRow,
  actor: Actor & { type: 'operator' | 'client' },
  localPath: string,
  name: string,
  purpose: FileRow['purpose'],
  extra: { requestId?: string; versionGroupId?: string; versionNumber?: number } = {},
): Promise<FileRow> {
  const check = await inspectFile(localPath, name);
  if (!check.ok) throw new HttpError(400, check.code, check.message);
  const id = newId('fil');
  const key = objectKey(p.id, id);
  const size = fs.statSync(localPath).size;
  const sha = await sha256File(localPath);
  await ctx.storage.putFile(key, localPath, check.mime);
  try {
    ctx.db
      .prepare(
        `INSERT INTO files (id, project_id, owner_id, uploader_type, uploader_id, original_name, storage_key, mime, size, sha256, purpose, request_id,
          version_group_id, version_number, preview_kind, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        p.id,
        p.owner_id,
        actor.type,
        actor.id,
        name,
        key,
        check.mime,
        size,
        sha,
        purpose,
        extra.requestId ?? null,
        extra.versionGroupId ?? null,
        extra.versionNumber ?? null,
        check.previewKind,
        check.width ?? null,
        check.height ?? null,
        nowIso(),
      );
  } catch (e) {
    await ctx.storage.delete(key).catch(() => undefined);
    throw e;
  }
  return ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow;
}

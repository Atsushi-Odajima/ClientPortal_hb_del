import type { FastifyReply } from 'fastify';
import { ZipArchive } from 'archiver';
import type { Ctx, DeliveryRow, FileRow } from '../context.js';
import { HttpError, contentDisposition, safeFileName } from '../util.js';
import { extOf } from '../fileTypes.js';

export interface ZipEntry {
  file: FileRow;
  path: string;
}

/**
 * 納品セットのZIPエントリを構築。
 * - delivery_items に含まれるファイルのみ（他案件・内部ファイル・旧版は含まれない）
 * - project_id を再照合し、他案件のファイルが紛れ込まないことを保証
 * - パスはサーバー側で安全化（ディレクトリトラバーサル・制御文字・重複を排除）
 */
export function buildZipEntries(ctx: Ctx, delivery: DeliveryRow): ZipEntry[] {
  const rows = ctx.db
    .prepare(
      `SELECT f.*, di.label, dv.version_number item_version, dl.title deliverable_title
       FROM delivery_items di
       JOIN files f ON f.id = di.file_id AND f.project_id = ?
       LEFT JOIN deliverable_versions dv ON dv.id = di.version_id AND dv.project_id = ?
       LEFT JOIN deliverables dl ON dl.id = dv.deliverable_id
       WHERE di.delivery_id = ? AND f.status = 'active' ORDER BY di.sort_order, di.id`,
    )
    .all(delivery.project_id, delivery.project_id, delivery.id) as (FileRow & { label: string; item_version: number | null; deliverable_title: string | null })[];
  const used = new Set<string>();
  const folder = safeFileName(delivery.title, 'delivery');
  return rows.map((r) => {
    const ext = extOf(r.original_name);
    let base = r.deliverable_title ? `${r.deliverable_title}_v${r.item_version}${ext ? `.${ext}` : ''}` : r.original_name;
    base = safeFileName(base, 'file');
    let name = base;
    let i = 2;
    while (used.has(name.toLowerCase())) {
      const dot = base.lastIndexOf('.');
      name = dot > 0 ? `${base.slice(0, dot)} (${i})${base.slice(dot)}` : `${base} (${i})`;
      i++;
    }
    used.add(name.toLowerCase());
    return { file: r, path: `${folder}/${name}` };
  });
}

export function assertZipSize(ctx: Ctx, entries: ZipEntry[]): void {
  const total = entries.reduce((s, e) => s + e.file.size, 0);
  if (total > ctx.cfg.limits.maxZipBytes) {
    throw new HttpError(413, 'zip_too_large', '合計サイズが大きいため一括ダウンロードできません。ファイルを個別にダウンロードしてください');
  }
  if (entries.length === 0) throw new HttpError(404, 'empty', 'ダウンロードできるファイルがありません');
}

/** ZIPをストリーミング生成（一時ファイルを作らない）。メディアは再圧縮しない（store） */
export async function streamZip(ctx: Ctx, reply: FastifyReply, zipName: string, entries: ZipEntry[]): Promise<void> {
  const archive = new ZipArchive({ store: true, forceZip64: entries.reduce((s, e) => s + e.file.size, 0) > 3.5 * 1024 ** 3 });
  reply.header('Content-Type', 'application/zip');
  reply.header('Content-Disposition', contentDisposition('attachment', zipName));
  reply.header('Cache-Control', 'private, no-store');
  reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
  reply.send(archive);
  archive.on('warning', (e: Error) => ctx.log.warn({ err: e.message }, 'zip warning'));
  archive.on('error', (e: Error) => ctx.log.error({ err: e.message }, 'zip error'));
  (async () => {
    try {
      for (const e of entries) {
        const obj = await ctx.storage.get(e.file.storage_key);
        archive.append(obj.stream, { name: e.path, date: new Date(e.file.created_at) });
        await new Promise<void>((resolve, reject) => {
          const onEntry = () => {
            archive.off('error', onErr);
            resolve();
          };
          const onErr = (err: Error) => {
            archive.off('entry', onEntry);
            reject(err);
          };
          archive.once('entry', onEntry);
          archive.once('error', onErr);
        });
      }
      await archive.finalize();
    } catch (err) {
      ctx.log.error({ err: (err as Error).message }, 'zip generation failed');
      archive.abort();
      reply.raw.destroy(err as Error);
    }
  })();
}

import type { ClientRow, DeliverableRow, FileRow, ProjectRow, VersionRow } from './context.js';
import type { DB } from './db.js';
import { HttpError, notFound } from './util.js';

/**
 * 認可はすべてサーバー側でここを通す。
 * 他者のIDを指定された場合は存在を明かさないよう 404 を返す。
 */

export function ownedProject(db: DB, ownerId: string, projectId: string): ProjectRow {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?').get(projectId, ownerId) as ProjectRow | undefined;
  if (!p) throw notFound('案件');
  return p;
}

export function ownedClient(db: DB, ownerId: string, clientId: string): ClientRow {
  const c = db.prepare('SELECT * FROM clients WHERE id = ? AND owner_id = ?').get(clientId, ownerId) as ClientRow | undefined;
  if (!c) throw notFound('顧客');
  return c;
}

/** 顧客が閲覧可能な案件: 有効なアクセス権 + ポータル公開中 + 非アーカイブ + 同一運営者 */
export function clientProject(db: DB, client: ClientRow, projectId: string): ProjectRow {
  const p = db
    .prepare(
      `SELECT p.* FROM projects p JOIN portal_access pa ON pa.project_id = p.id
       WHERE p.id = ? AND pa.client_id = ? AND pa.status = 'active'
         AND p.owner_id = ? AND p.portal_status = 'published' AND p.archived_at IS NULL`,
    )
    .get(projectId, client.id, client.owner_id) as ProjectRow | undefined;
  if (!p) throw notFound('案件');
  return p;
}

export function clientProjects(db: DB, client: ClientRow): ProjectRow[] {
  return db
    .prepare(
      `SELECT p.* FROM projects p JOIN portal_access pa ON pa.project_id = p.id
       WHERE pa.client_id = ? AND pa.status = 'active' AND p.owner_id = ?
         AND p.portal_status = 'published' AND p.archived_at IS NULL
       ORDER BY p.updated_at DESC`,
    )
    .all(client.id, client.owner_id) as ProjectRow[];
}

export function projectDeliverable(db: DB, projectId: string, deliverableId: string): DeliverableRow {
  const d = db.prepare('SELECT * FROM deliverables WHERE id = ? AND project_id = ?').get(deliverableId, projectId) as DeliverableRow | undefined;
  if (!d) throw notFound('制作物');
  return d;
}

export function projectVersion(db: DB, projectId: string, versionId: string): VersionRow {
  const v = db.prepare('SELECT * FROM deliverable_versions WHERE id = ? AND project_id = ?').get(versionId, projectId) as VersionRow | undefined;
  if (!v) throw notFound('バージョン');
  return v;
}

export function latestVersion(db: DB, deliverableId: string): VersionRow | undefined {
  return db
    .prepare('SELECT * FROM deliverable_versions WHERE deliverable_id = ? ORDER BY version_number DESC LIMIT 1')
    .get(deliverableId) as VersionRow | undefined;
}

export function projectFile(db: DB, projectId: string, fileId: string): FileRow {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND project_id = ?').get(fileId, projectId) as FileRow | undefined;
  if (!f) throw notFound('ファイル');
  return f;
}

/**
 * 顧客がこのファイルを閲覧・取得できるか。
 * - internal（作業ファイル）: 不可
 * - request_attachment: 取り下げ済みは不可
 * - deliverable_version: 提出済み version に紐づくもののみ
 * - delivery_extra: 公開中かつ期限内の納品セットに含まれるもののみ
 */
export function assertClientCanReadFile(db: DB, file: FileRow): void {
  if (file.status !== 'active') throw notFound('ファイル');
  switch (file.purpose) {
    case 'internal':
      throw notFound('ファイル');
    case 'request_attachment':
      return;
    case 'deliverable_version': {
      const v = db.prepare('SELECT 1 FROM deliverable_versions WHERE file_id = ?').get(file.id);
      if (!v) throw notFound('ファイル');
      return;
    }
    case 'delivery_extra': {
      const ok = db
        .prepare(
          `SELECT d.expires_at FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id
           WHERE di.file_id = ? AND d.status = 'published'`,
        )
        .all(file.id) as { expires_at: string | null }[];
      if (ok.length === 0) throw notFound('ファイル');
      if (!ok.some((r) => !r.expires_at || Date.parse(r.expires_at) > Date.now())) {
        throw new HttpError(410, 'expired', 'ダウンロード期限が過ぎています。担当者にご連絡ください');
      }
      return;
    }
    default:
      throw notFound('ファイル');
  }
}

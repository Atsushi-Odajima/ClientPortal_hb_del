import type { Actor, Ctx, ProjectRow } from '../context.js';
import { audit } from '../audit.js';

/**
 * 案件の完全削除: DBレコード（監査ログを除く）とストレージ実体を削除する。
 * - 監査ログは説明責任のため残す（本文・ファイル内容は元々含まない）
 * - バックアップ内のデータはバックアップの保持期間が過ぎるまで残る（OPERATIONS.md 参照）
 * - DB削除を先にコミットし、その後ストレージを削除（失敗した実体は孤立ファイル掃除で回収）
 */
export async function deleteProjectCompletely(ctx: Ctx, p: ProjectRow, actor: Actor): Promise<{ filesDeleted: number; storageErrors: number }> {
  const { db } = ctx;
  const keys = (db.prepare('SELECT storage_key FROM files WHERE project_id = ?').all(p.id) as { storage_key: string }[]).map((r) => r.storage_key);
  db.transaction(() => {
    db.prepare('DELETE FROM delivery_items WHERE delivery_id IN (SELECT id FROM deliveries WHERE project_id = ?)').run(p.id);
    db.prepare('DELETE FROM deliveries WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM approvals WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM change_requests WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM comments WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM deliverable_versions WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM deliverables WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM uploads WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM files WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM document_requests WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM invites WHERE access_id IN (SELECT id FROM portal_access WHERE project_id = ?)').run(p.id);
    db.prepare('DELETE FROM portal_access WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM project_status_history WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM notifications WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    audit(db, {
      ownerId: p.owner_id,
      projectId: p.id,
      actor,
      action: 'project.deleted',
      targetType: 'project',
      targetId: p.id,
      summary: `案件を削除（ファイル${keys.length}件）`,
    });
  })();
  let storageErrors = 0;
  for (const k of keys) {
    try {
      await ctx.storage.delete(k);
    } catch {
      storageErrors++;
    }
  }
  return { filesDeleted: keys.length, storageErrors };
}

import type { Actor, Ctx, ProjectRow } from '../context.js';
import type { DB } from '../db.js';
import { audit } from '../audit.js';
import { newId, nowIso } from '../util.js';
import { PROJECT_STATUS_CLIENT_LABEL, PROJECT_STATUS_LABEL, type ProjectStatus } from '../../../shared/labels.js';

export function setProjectStatus(ctx: Ctx, project: ProjectRow, to: ProjectStatus, actor: Actor, note = ''): void {
  if (project.status === to) return;
  const now = nowIso();
  ctx.db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(to, now, project.id);
  ctx.db
    .prepare(
      `INSERT INTO project_status_history (id, project_id, from_status, to_status, changed_by_type, changed_by_id, note, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId('psh'), project.id, project.status, to, actor.type, actor.id, note.slice(0, 500), now);
  audit(ctx.db, {
    ownerId: project.owner_id,
    projectId: project.id,
    actor,
    action: 'project.status_changed',
    targetType: 'project',
    targetId: project.id,
    summary: `状況: ${project.client_status_label || PROJECT_STATUS_CLIENT_LABEL[to]}`,
    detail: { from: project.status, to, fromLabel: PROJECT_STATUS_LABEL[project.status as ProjectStatus], toLabel: PROJECT_STATUS_LABEL[to] },
    clientVisible: true,
  });
  project.status = to;
}

const SYSTEM: Actor = { type: 'system', id: 'system', name: '自動更新' };

/** 業務イベントに応じた案件状態の自動遷移（運営者はいつでも手動変更可能） */
export function autoTransition(
  ctx: Ctx,
  projectId: string,
  event: 'version_submitted' | 'change_requested' | 'approved' | 'delivery_published',
): void {
  const p = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
  if (!p) return;
  const s = p.status as ProjectStatus;
  if (['on_hold', 'cancelled', 'completed'].includes(s)) return;
  switch (event) {
    case 'version_submitted':
      if (['preparing', 'waiting_materials', 'in_production', 'revising', 'approved'].includes(s)) setProjectStatus(ctx, p, 'client_review', SYSTEM);
      break;
    case 'change_requested':
      if (['client_review', 'approved'].includes(s)) setProjectStatus(ctx, p, 'revising', SYSTEM);
      break;
    case 'approved':
      if (allLatestApproved(ctx.db, projectId) && ['client_review', 'revising', 'in_production'].includes(s)) setProjectStatus(ctx, p, 'approved', SYSTEM);
      break;
    case 'delivery_published':
      if (s !== 'delivered') setProjectStatus(ctx, p, 'delivered', SYSTEM);
      break;
  }
}

export function allLatestApproved(db: DB, projectId: string): boolean {
  const rows = db
    .prepare(
      `SELECT dv.status FROM deliverables d
       JOIN deliverable_versions dv ON dv.deliverable_id = d.id
         AND dv.version_number = (SELECT MAX(version_number) FROM deliverable_versions WHERE deliverable_id = d.id)
       WHERE d.project_id = ?`,
    )
    .all(projectId) as { status: string }[];
  return rows.length > 0 && rows.every((r) => r.status === 'approved');
}

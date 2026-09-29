import type { ApprovalRow, DeliverableRow, DeliveryRow, FileRow, ProjectRow, RequestRow, VersionRow } from '../context.js';
import type { DB } from '../db.js';
import { parseJsonArray } from '../util.js';
import {
  PROJECT_STATUS_CLIENT_LABEL,
  PROJECT_STATUS_LABEL,
  REQUEST_STATUS_LABEL,
  VERSION_STATUS_LABEL,
  type ProjectStatus,
} from '../../../shared/labels.js';

export type Audience = 'operator' | 'client';

export function fileDto(f: FileRow, audience: Audience) {
  const base = audience === 'operator' ? `/api/app/projects/${f.project_id}/files/${f.id}` : `/api/portal/projects/${f.project_id}/files/${f.id}`;
  return {
    id: f.id,
    name: f.original_name,
    mime: f.mime,
    size: f.size,
    sha256: f.sha256,
    purpose: f.purpose,
    previewKind: f.preview_kind,
    width: f.width,
    height: f.height,
    uploaderType: f.uploader_type,
    status: f.status,
    versionGroupId: f.version_group_id,
    versionNumber: f.version_number,
    createdAt: f.created_at,
    url: `${base}/content`,
    downloadUrl: `${base}/content?dl=1`,
  };
}

export function projectDto(p: ProjectRow, audience: Audience, clientName?: string) {
  const status = p.status as ProjectStatus;
  const clientLabel = p.client_status_label || PROJECT_STATUS_CLIENT_LABEL[status];
  const common = {
    id: p.id,
    name: p.name,
    description: p.description,
    startDate: p.start_date,
    dueDate: p.due_date,
    clientGuidance: p.client_guidance,
    clientStatusLabel: clientLabel,
    updatedAt: p.updated_at,
  };
  if (audience === 'client') return common;
  return {
    ...common,
    clientId: p.client_id,
    clientName,
    status,
    statusLabel: PROJECT_STATUS_LABEL[status],
    customClientStatusLabel: p.client_status_label,
    internalMemo: p.internal_memo,
    portalStatus: p.portal_status,
    categories: parseJsonArray<string>(p.categories_json),
    checklist: parseJsonArray<string>(p.checklist_json),
    isSample: !!p.is_sample,
    archived: !!p.archived_at,
    archivedAt: p.archived_at,
    createdAt: p.created_at,
  };
}

export function requestDto(db: DB, r: RequestRow, audience: Audience) {
  const files = db
    .prepare(`SELECT * FROM files WHERE request_id = ? AND status = 'active' ORDER BY created_at`)
    .all(r.id) as FileRow[];
  const dto = {
    id: r.id,
    title: r.title,
    description: r.description,
    kind: r.kind,
    required: !!r.required,
    dueDate: r.due_date,
    choices: parseJsonArray<string>(r.choices_json),
    status: r.status,
    statusLabel: REQUEST_STATUS_LABEL[r.status],
    answer: {
      text: r.answer_text,
      url: r.answer_url,
      choice: r.answer_choice,
      checked: r.answer_checked === null ? null : !!r.answer_checked,
    },
    files: files.map((f) => fileDto(f, audience)),
    submittedAt: r.submitted_at,
    reviewedAt: r.reviewed_at,
    returnReason: r.return_reason,
    sortOrder: r.sort_order,
  };
  if (audience === 'client') return dto;
  return { ...dto, internalMemo: r.internal_memo };
}

export function approvalDto(a: ApprovalRow) {
  return {
    id: a.id,
    versionId: a.version_id,
    versionNumber: a.version_number,
    clientName: a.client_name,
    fileSha256: a.file_sha256,
    comment: a.comment,
    approvedAt: a.approved_at,
    revokedAt: a.revoked_at,
    revokedByType: a.revoked_by_type,
    revokeReason: a.revoke_reason,
  };
}

export function versionDto(db: DB, v: VersionRow, audience: Audience, latestNumber: number) {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(v.file_id) as FileRow;
  const counts = db
    .prepare(
      `SELECT COUNT(*) total, SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) open
       FROM comments WHERE version_id = ? AND deleted_at IS NULL`,
    )
    .get(v.id) as { total: number; open: number | null };
  const approvals = db.prepare('SELECT * FROM approvals WHERE version_id = ? ORDER BY approved_at').all(v.id) as ApprovalRow[];
  const active = approvals.find((a) => !a.revoked_at) ?? null;
  const changeRequests = db
    .prepare('SELECT id, client_name, body, created_at FROM change_requests WHERE version_id = ? ORDER BY created_at')
    .all(v.id) as { id: string; client_name: string; body: string; created_at: string }[];
  return {
    id: v.id,
    deliverableId: v.deliverable_id,
    versionNumber: v.version_number,
    isLatest: v.version_number === latestNumber,
    note: v.note,
    checklist: parseJsonArray<string>(v.checklist_json),
    reviewDueDate: v.review_due_date,
    status: v.status,
    statusLabel: VERSION_STATUS_LABEL[v.status],
    submittedAt: v.submitted_at,
    file: fileDto(file, audience),
    commentCount: counts.total,
    openCommentCount: counts.open ?? 0,
    approval: active ? approvalDto(active) : null,
    approvalHistory: approvals.map(approvalDto),
    changeRequests: changeRequests.map((c) => ({ id: c.id, clientName: c.client_name, body: c.body, createdAt: c.created_at })),
  };
}

export function deliverableDto(db: DB, d: DeliverableRow, audience: Audience) {
  const versions = db
    .prepare('SELECT * FROM deliverable_versions WHERE deliverable_id = ? ORDER BY version_number DESC')
    .all(d.id) as VersionRow[];
  const latestNumber = versions[0]?.version_number ?? 0;
  const latest = versions[0];
  return {
    id: d.id,
    title: d.title,
    category: d.category,
    description: d.description,
    sortOrder: d.sort_order,
    status: latest ? latest.status : 'draft',
    statusLabel: latest ? VERSION_STATUS_LABEL[latest.status] : '未提出',
    latestVersionNumber: latestNumber,
    versions: versions.map((v) => versionDto(db, v, audience, latestNumber)),
    updatedAt: d.updated_at,
  };
}

export function deliveryDto(db: DB, d: DeliveryRow, audience: Audience) {
  const items = db
    .prepare(
      `SELECT di.*, f.original_name, dv.version_number, dl.title deliverable_title
       FROM delivery_items di JOIN files f ON f.id = di.file_id
       LEFT JOIN deliverable_versions dv ON dv.id = di.version_id
       LEFT JOIN deliverables dl ON dl.id = dv.deliverable_id
       WHERE di.delivery_id = ? ORDER BY di.sort_order, di.id`,
    )
    .all(d.id) as {
    id: string;
    version_id: string | null;
    approval_id: string | null;
    file_id: string;
    label: string;
    original_name: string;
    version_number: number | null;
    deliverable_title: string | null;
  }[];
  const expired = !!d.expires_at && Date.parse(d.expires_at) < Date.now();
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    notice: d.notice,
    expiresAt: d.expires_at,
    expired,
    status: d.status,
    publishedAt: d.published_at,
    createdAt: d.created_at,
    items: items.map((i) => {
      const f = db.prepare('SELECT * FROM files WHERE id = ?').get(i.file_id) as FileRow;
      return {
        id: i.id,
        label: i.label || (i.deliverable_title ? `${i.deliverable_title} v${i.version_number}` : i.original_name),
        versionId: i.version_id,
        versionNumber: i.version_number,
        deliverableTitle: i.deliverable_title,
        approvalId: i.approval_id,
        file: fileDto(f, audience),
      };
    }),
    zipUrl:
      audience === 'client'
        ? `/api/portal/projects/${d.project_id}/deliveries/${d.id}/zip`
        : `/api/app/projects/${d.project_id}/deliveries/${d.id}/zip`,
  };
}

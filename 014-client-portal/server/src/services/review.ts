import type { Actor, ApprovalRow, Ctx, DeliverableRow, FileRow, ProjectRow, VersionRow } from '../context.js';
import { audit } from '../audit.js';
import { latestVersion, projectDeliverable, projectVersion } from '../access.js';
import { notify, notifyProjectClients } from '../notify.js';
import { HttpError, badRequest, conflict, newId, notFound, nowIso } from '../util.js';
import { autoTransition, setProjectStatus } from './projectState.js';
import { approvalDto } from './dto.js';
import { PIN_TYPE_LABEL, normalizePinType, type PinType } from '../../../shared/correctionSheet.js';

interface Meta {
  ipHash: string;
  userAgent: string;
}

export interface CommentRow {
  id: string;
  project_id: string;
  deliverable_id: string;
  version_id: string;
  parent_id: string | null;
  author_type: 'operator' | 'client';
  author_id: string;
  author_name: string;
  body: string;
  pin_x: number | null;
  pin_y: number | null;
  pin_number: number | null;
  /** Client Portal 修正指示: ピンの指示タイプ（ピンなしは NULL） */
  pin_type: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

export function commentDto(c: CommentRow, viewer: { type: string; id: string }) {
  const deleted = !!c.deleted_at;
  return {
    id: c.id,
    versionId: c.version_id,
    parentId: c.parent_id,
    authorType: c.author_type,
    authorName: c.author_name,
    mine: c.author_type === viewer.type && c.author_id === viewer.id,
    body: deleted ? '' : c.body,
    deleted,
    pin:
      c.pin_x !== null && c.pin_y !== null
        ? { x: c.pin_x, y: c.pin_y, number: c.pin_number, type: normalizePinType(c.pin_type), typeLabel: PIN_TYPE_LABEL[normalizePinType(c.pin_type)] }
        : null,
    resolved: !!c.resolved_at,
    resolvedAt: c.resolved_at,
    edited: !!c.edited_at,
    editedAt: c.edited_at,
    createdAt: c.created_at,
  };
}

export function listComments(ctx: Ctx, versionId: string, viewer: { type: string; id: string }) {
  const rows = ctx.db.prepare('SELECT * FROM comments WHERE version_id = ? ORDER BY created_at').all(versionId) as CommentRow[];
  return rows.map((r) => commentDto(r, viewer));
}

function deliverableLabel(d: DeliverableRow, v: VersionRow) {
  return `${d.title} v${v.version_number}`;
}

export function createComment(
  ctx: Ctx,
  p: ProjectRow,
  actor: Actor & { type: 'operator' | 'client' },
  versionId: string,
  input: { body: string; pin?: { x: number; y: number } | null; pinType?: PinType | null; parentId?: string | null },
  meta: Meta,
) {
  const { db } = ctx;
  const v = projectVersion(db, p.id, versionId);
  const d = projectDeliverable(db, p.id, v.deliverable_id);
  const body = input.body.trim();
  if (!body) throw badRequest('コメントを入力してください');
  let pinNumber: number | null = null;
  if (input.pin) {
    const file = db.prepare('SELECT preview_kind FROM files WHERE id = ?').get(v.file_id) as { preview_kind: string };
    if (file.preview_kind !== 'image') throw badRequest('ピンコメントは画像にのみ付けられます');
    if (input.parentId) throw badRequest('返信にはピンを付けられません');
  }
  if (input.parentId) {
    const parent = db.prepare('SELECT * FROM comments WHERE id = ? AND version_id = ?').get(input.parentId, v.id) as CommentRow | undefined;
    if (!parent || parent.parent_id) throw notFound('返信先コメント');
  }
  const id = newId('cmt');
  db.transaction(() => {
    if (input.pin) {
      pinNumber = ((db.prepare('SELECT COALESCE(MAX(pin_number), 0) m FROM comments WHERE version_id = ?').get(v.id) as { m: number }).m ?? 0) + 1;
    }
    db.prepare(
      `INSERT INTO comments (id, project_id, deliverable_id, version_id, parent_id, author_type, author_id, author_name, body, pin_x, pin_y, pin_number, pin_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      p.id,
      d.id,
      v.id,
      input.parentId ?? null,
      actor.type,
      actor.id,
      actor.name,
      body,
      input.pin?.x ?? null,
      input.pin?.y ?? null,
      pinNumber,
      input.pin ? normalizePinType(input.pinType) : null,
      nowIso(),
    );
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), p.id);
    audit(db, {
      ownerId: p.owner_id,
      projectId: p.id,
      actor,
      action: 'comment.created',
      targetType: 'version',
      targetId: v.id,
      summary: `${deliverableLabel(d, v)} に${pinNumber ? `ピン#${pinNumber}の` : ''}コメント`,
      detail: { commentId: id, deliverableId: d.id, pin: pinNumber },
      clientVisible: true,
      ...meta,
    });
    const link = `/portal/p/${p.id}/review/${d.id}`;
    if (actor.type === 'client') {
      notify(ctx, {
        ownerId: p.owner_id,
        recipientType: 'operator',
        recipientId: p.owner_id,
        projectId: p.id,
        kind: 'comment',
        title: `${actor.name}さんがコメントしました（${deliverableLabel(d, v)}）`,
        body: body.slice(0, 120),
        link: `/app/projects/${p.id}/deliverables/${d.id}`,
        dedupeKey: `cmt:${id}`,
      });
    } else {
      notifyProjectClients(ctx, p.id, {
        ownerId: p.owner_id,
        kind: 'comment',
        title: `コメントが届きました（${deliverableLabel(d, v)}）`,
        body: body.slice(0, 120),
        link,
        dedupeKey: `cmt:${id}`,
      });
    }
  })();
  return { id, pinNumber };
}

export function getOwnComment(ctx: Ctx, p: ProjectRow, commentId: string, actor: Actor): CommentRow {
  const c = ctx.db.prepare('SELECT * FROM comments WHERE id = ? AND project_id = ?').get(commentId, p.id) as CommentRow | undefined;
  if (!c) throw notFound('コメント');
  if (c.author_type !== actor.type || c.author_id !== actor.id) throw new HttpError(403, 'forbidden', '自分のコメントのみ編集・削除できます');
  if (c.deleted_at) throw conflict('削除済みのコメントです');
  return c;
}

export function editComment(ctx: Ctx, p: ProjectRow, commentId: string, actor: Actor, body: string, meta: Meta, pinType?: PinType) {
  const c = getOwnComment(ctx, p, commentId, actor);
  if (!body.trim()) throw badRequest('コメントを入力してください');
  if (pinType && c.pin_number === null) throw badRequest('指示タイプはピンコメントにのみ設定できます');
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE comments SET body = ?, pin_type = COALESCE(?, pin_type), edited_at = ? WHERE id = ?').run(body.trim(), pinType ?? null, nowIso(), c.id);
    audit(ctx.db, { ownerId: p.owner_id, projectId: p.id, actor, action: 'comment.edited', targetType: 'comment', targetId: c.id, ...meta });
  })();
}

export function deleteComment(ctx: Ctx, p: ProjectRow, commentId: string, actor: Actor, meta: Meta) {
  const c = getOwnComment(ctx, p, commentId, actor);
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(nowIso(), c.id);
    audit(ctx.db, { ownerId: p.owner_id, projectId: p.id, actor, action: 'comment.deleted', targetType: 'comment', targetId: c.id, ...meta });
  })();
}

export function resolveComment(ctx: Ctx, p: ProjectRow, commentId: string, actor: Actor, resolved: boolean, meta: Meta) {
  const c = ctx.db.prepare('SELECT * FROM comments WHERE id = ? AND project_id = ?').get(commentId, p.id) as CommentRow | undefined;
  if (!c || c.deleted_at) throw notFound('コメント');
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?').run(resolved ? nowIso() : null, resolved ? `${actor.type}:${actor.id}` : null, c.id);
    audit(ctx.db, {
      ownerId: p.owner_id,
      projectId: p.id,
      actor,
      action: resolved ? 'comment.resolved' : 'comment.reopened',
      targetType: 'comment',
      targetId: c.id,
      detail: { pin: c.pin_number },
      ...meta,
    });
  })();
}

export function requestChanges(
  ctx: Ctx,
  p: ProjectRow,
  client: { id: string; name: string },
  versionId: string,
  body: string,
  meta: Meta,
) {
  const { db } = ctx;
  const v = projectVersion(db, p.id, versionId);
  const d = projectDeliverable(db, p.id, v.deliverable_id);
  const text = body.trim();
  if (!text) throw badRequest('修正内容を入力してください');
  const result = db.transaction(() => {
    const latest = latestVersion(db, d.id)!;
    if (latest.id !== v.id) {
      throw conflict(`新しい版（v${latest.version_number}）が提出されています。最新版をご確認ください`, 'stale_version', { latestVersionId: latest.id, latestVersionNumber: latest.version_number });
    }
    const cur = db.prepare('SELECT status FROM deliverable_versions WHERE id = ?').get(v.id) as { status: string };
    if (cur.status === 'approved') throw conflict('この版は承認済みです。修正が必要な場合は先に承認を取り消してください', 'already_approved');
    const pinIds = (db.prepare('SELECT id FROM comments WHERE version_id = ? AND pin_number IS NOT NULL AND deleted_at IS NULL AND resolved_at IS NULL').all(v.id) as { id: string }[]).map(
      (r) => r.id,
    );
    const id = newId('chg');
    db.prepare(
      `INSERT INTO change_requests (id, project_id, deliverable_id, version_id, client_id, client_name, body, pin_comment_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, p.id, d.id, v.id, client.id, client.name, text, JSON.stringify(pinIds), nowIso());
    db.prepare(`UPDATE deliverable_versions SET status = 'changes_requested' WHERE id = ?`).run(v.id);
    db.prepare('UPDATE deliverables SET updated_at = ? WHERE id = ?').run(nowIso(), d.id);
    audit(db, {
      ownerId: p.owner_id,
      projectId: p.id,
      actor: { type: 'client', id: client.id, name: client.name },
      action: 'change_request.created',
      targetType: 'version',
      targetId: v.id,
      summary: `${deliverableLabel(d, v)} に修正依頼`,
      detail: { changeRequestId: id, deliverableId: d.id, versionNumber: v.version_number, pins: pinIds.length },
      clientVisible: true,
      ...meta,
    });
    notify(ctx, {
      ownerId: p.owner_id,
      recipientType: 'operator',
      recipientId: p.owner_id,
      projectId: p.id,
      kind: 'change_request',
      title: `修正依頼: ${deliverableLabel(d, v)}（${client.name}）`,
      body: text.slice(0, 200),
      link: `/app/projects/${p.id}/deliverables/${d.id}`,
      dedupeKey: `chg:${id}`,
    });
    autoTransition(ctx, p.id, 'change_requested');
    return { id };
  })();
  return result;
}

export function approveVersion(
  ctx: Ctx,
  p: ProjectRow,
  client: { id: string; name: string },
  input: { versionId: string; idempotencyKey: string; expectedVersionNumber?: number; comment: string },
  meta: Meta,
): { approval: ReturnType<typeof approvalDto>; duplicate: boolean } {
  const { db } = ctx;
  return db.transaction(() => {
    const existingByKey = db.prepare('SELECT * FROM approvals WHERE idempotency_key = ?').get(input.idempotencyKey) as ApprovalRow | undefined;
    if (existingByKey) {
      if (existingByKey.version_id !== input.versionId || existingByKey.client_id !== client.id || existingByKey.project_id !== p.id) {
        throw conflict('リクエストが重複しています。画面を再読み込みしてください', 'idempotency_conflict');
      }
      return { approval: approvalDto(existingByKey), duplicate: true };
    }
    // 承認直前に、対象が最新版であることをサーバーで再確認
    const v = projectVersion(db, p.id, input.versionId);
    const d = projectDeliverable(db, p.id, v.deliverable_id);
    const latest = latestVersion(db, d.id)!;
    if (latest.id !== v.id || (input.expectedVersionNumber !== undefined && input.expectedVersionNumber !== v.version_number)) {
      throw conflict(`この版（v${v.version_number}）は最新版ではありません。最新版（v${latest.version_number}）をご確認ください`, 'stale_version', {
        latestVersionId: latest.id,
        latestVersionNumber: latest.version_number,
      });
    }
    const active = db.prepare('SELECT * FROM approvals WHERE version_id = ? AND revoked_at IS NULL').get(v.id) as ApprovalRow | undefined;
    if (active) return { approval: approvalDto(active), duplicate: true };
    if (v.status !== 'in_review' && v.status !== 'changes_requested') {
      throw conflict('この版は現在承認できない状態です', 'not_approvable');
    }
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(v.file_id) as FileRow;
    const id = newId('apr');
    db.prepare(
      `INSERT INTO approvals (id, project_id, deliverable_id, version_id, version_number, client_id, client_name, file_id, file_sha256, comment, idempotency_key, user_agent, ip_hash, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      p.id,
      d.id,
      v.id,
      v.version_number,
      client.id,
      client.name,
      file.id,
      file.sha256,
      input.comment.trim().slice(0, 1000),
      input.idempotencyKey,
      meta.userAgent,
      meta.ipHash,
      nowIso(),
    );
    db.prepare(`UPDATE deliverable_versions SET status = 'approved' WHERE id = ?`).run(v.id);
    db.prepare('UPDATE deliverables SET updated_at = ? WHERE id = ?').run(nowIso(), d.id);
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), p.id);
    audit(db, {
      ownerId: p.owner_id,
      projectId: p.id,
      actor: { type: 'client', id: client.id, name: client.name },
      action: 'approval.created',
      targetType: 'version',
      targetId: v.id,
      summary: `${deliverableLabel(d, v)} を承認`,
      detail: { approvalId: id, deliverableId: d.id, versionNumber: v.version_number, fileSha256: file.sha256 },
      clientVisible: true,
      ...meta,
    });
    notify(ctx, {
      ownerId: p.owner_id,
      recipientType: 'operator',
      recipientId: p.owner_id,
      projectId: p.id,
      kind: 'approval',
      title: `承認されました: ${deliverableLabel(d, v)}（${client.name}）`,
      link: `/app/projects/${p.id}/deliverables/${d.id}`,
      dedupeKey: `apr:${id}`,
    });
    autoTransition(ctx, p.id, 'approved');
    const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow;
    return { approval: approvalDto(row), duplicate: false };
  })();
}

export function revokeApproval(ctx: Ctx, p: ProjectRow, approvalId: string, actor: Actor, reason: string, meta: Meta) {
  const { db } = ctx;
  const text = reason.trim();
  if (!text) throw badRequest('取消理由を入力してください');
  db.transaction(() => {
    const a = db.prepare('SELECT * FROM approvals WHERE id = ? AND project_id = ?').get(approvalId, p.id) as ApprovalRow | undefined;
    if (!a) throw notFound('承認');
    if (actor.type === 'client' && a.client_id !== actor.id) throw new HttpError(403, 'forbidden', 'ご自身の承認のみ取り消せます');
    if (a.revoked_at) throw conflict('すでに取り消されています', 'already_revoked');
    const inDelivery = db
      .prepare(`SELECT 1 FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id WHERE di.approval_id = ? AND d.status = 'published'`)
      .get(a.id);
    if (inDelivery) throw conflict('公開中の納品に含まれているため取り消せません。先に納品を取り下げてください', 'in_delivery');
    db.prepare('UPDATE approvals SET revoked_at = ?, revoked_by_type = ?, revoked_by_id = ?, revoke_reason = ? WHERE id = ?').run(
      nowIso(),
      actor.type,
      actor.id,
      text.slice(0, 1000),
      a.id,
    );
    const v = db.prepare('SELECT * FROM deliverable_versions WHERE id = ?').get(a.version_id) as VersionRow;
    const latest = latestVersion(db, v.deliverable_id)!;
    if (latest.id === v.id && v.status === 'approved') db.prepare(`UPDATE deliverable_versions SET status = 'in_review' WHERE id = ?`).run(v.id);
    const d = db.prepare('SELECT * FROM deliverables WHERE id = ?').get(v.deliverable_id) as DeliverableRow;
    audit(db, {
      ownerId: p.owner_id,
      projectId: p.id,
      actor,
      action: 'approval.revoked',
      targetType: 'approval',
      targetId: a.id,
      summary: `${deliverableLabel(d, v)} の承認を取消`,
      detail: { versionId: v.id, versionNumber: v.version_number },
      clientVisible: true,
      ...meta,
    });
    if (actor.type === 'client') {
      notify(ctx, {
        ownerId: p.owner_id,
        recipientType: 'operator',
        recipientId: p.owner_id,
        projectId: p.id,
        kind: 'approval_revoked',
        title: `承認が取り消されました: ${deliverableLabel(d, v)}`,
        body: text.slice(0, 200),
        link: `/app/projects/${p.id}/deliverables/${d.id}`,
        dedupeKey: `aprrev:${a.id}`,
      });
    } else {
      notifyProjectClients(ctx, p.id, {
        ownerId: p.owner_id,
        kind: 'approval_revoked',
        title: `承認が取り消されました: ${deliverableLabel(d, v)}`,
        body: text.slice(0, 200),
        link: `/portal/p/${p.id}/review/${d.id}`,
        dedupeKey: `aprrev:${a.id}`,
      });
    }
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id) as ProjectRow;
    if (proj.status === 'approved') setProjectStatus(ctx, proj, 'client_review', { type: 'system', id: 'system', name: '自動更新' });
  })();
}

/** 新versionの作成（ファイル保存成功後に呼ばれる。呼び出し側トランザクション内で実行） */
export function insertVersion(
  ctx: Ctx,
  p: ProjectRow,
  d: DeliverableRow,
  file: FileRow,
  actor: Actor,
  input: { note: string; checklist: string[]; reviewDueDate: string | null },
): VersionRow {
  const { db } = ctx;
  const prev = latestVersion(db, d.id);
  const num = (prev?.version_number ?? 0) + 1;
  if (prev && prev.status !== 'superseded') {
    // 旧版は上書き・削除せず「旧版」として保持。旧版の承認は新版へ引継がない
    db.prepare(`UPDATE deliverable_versions SET status = 'superseded' WHERE id = ?`).run(prev.id);
  }
  const id = newId('ver');
  const now = nowIso();
  db.prepare(
    `INSERT INTO deliverable_versions (id, deliverable_id, project_id, version_number, file_id, note, checklist_json, review_due_date, status, submitted_by, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_review', ?, ?)`,
  ).run(id, d.id, p.id, num, file.id, input.note, JSON.stringify(input.checklist), input.reviewDueDate, actor.id, now);
  db.prepare('UPDATE deliverables SET updated_at = ? WHERE id = ?').run(now, d.id);
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, p.id);
  audit(db, {
    ownerId: p.owner_id,
    projectId: p.id,
    actor,
    action: num === 1 ? 'version.submitted' : 'version.new_version',
    targetType: 'version',
    targetId: id,
    summary: `${d.title} v${num} を提出`,
    detail: { deliverableId: d.id, versionNumber: num, fileId: file.id, sha256: file.sha256, previousStatus: prev?.status ?? null },
    clientVisible: true,
  });
  notifyProjectClients(ctx, p.id, {
    ownerId: p.owner_id,
    kind: 'version_submitted',
    title: `確認をお願いします: ${d.title} v${num}`,
    body: input.note.slice(0, 200),
    link: `/portal/p/${p.id}/review/${d.id}`,
    dedupeKey: `ver:${id}`,
  });
  autoTransition(ctx, p.id, 'version_submitted');
  return db.prepare('SELECT * FROM deliverable_versions WHERE id = ?').get(id) as VersionRow;
}

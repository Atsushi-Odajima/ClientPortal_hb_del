import type { Ctx } from './context.js';
import { newId, nowIso } from './util.js';

export type NotificationKind =
  | 'request_submitted'
  | 'request_returned'
  | 'request_accepted'
  | 'version_submitted'
  | 'comment'
  | 'change_request'
  | 'approval'
  | 'approval_revoked'
  | 'delivery_published'
  | 'overdue'
  | 'invite';

export interface NotifyInput {
  ownerId: string;
  recipientType: 'operator' | 'client';
  recipientId: string;
  projectId?: string | null;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
  dedupeKey?: string;
}

/** アプリ内通知を作成し、メールが有効ならポータルへの誘導メールを outbox に積む（添付なし） */
export function notify(ctx: Ctx, n: NotifyInput): void {
  const { db } = ctx;
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO notifications (id, owner_id, recipient_type, recipient_id, project_id, kind, title, body, link, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId('ntf'),
      n.ownerId,
      n.recipientType,
      n.recipientId,
      n.projectId ?? null,
      n.kind,
      n.title.slice(0, 200),
      (n.body ?? '').slice(0, 500),
      n.link ?? '',
      n.dedupeKey ?? null,
      nowIso(),
    );
  if (res.changes === 0 || !ctx.mailer.enabled) return;
  // サンプル案件ではメールを送らない
  if (n.projectId) {
    const sample = db.prepare('SELECT is_sample FROM projects WHERE id = ?').get(n.projectId) as { is_sample: number } | undefined;
    if (sample?.is_sample) return;
  }
  const setting = db
    .prepare('SELECT email_enabled FROM notification_settings WHERE recipient_type=? AND recipient_id=?')
    .get(n.recipientType, n.recipientId) as { email_enabled: number } | undefined;
  if (setting && !setting.email_enabled) return;
  const email =
    n.recipientType === 'operator'
      ? (db.prepare('SELECT email FROM operators WHERE id=?').get(n.recipientId) as { email: string } | undefined)?.email
      : (db.prepare(`SELECT email FROM clients WHERE id=? AND status='active'`).get(n.recipientId) as { email: string } | undefined)?.email;
  if (!email) return;
  const url = `${ctx.cfg.publicUrl}${n.link || (n.recipientType === 'operator' ? '/app' : '/portal')}`;
  ctx.mailer.enqueue(db, {
    to: email,
    subject: `[Client Portal] ${n.title}`,
    text: `${n.title}\n\n${n.body ?? ''}\n\n詳細はポータルでご確認ください:\n${url}\n\n※ファイルはメールに添付されません。ポータルからご確認ください。\n※このメールは送信専用です。`,
    dedupeKey: n.dedupeKey ? `mail:${n.dedupeKey}` : undefined,
  });
}

/** 案件の顧客（有効なアクセス権を持つ全顧客）へ通知 */
export function notifyProjectClients(ctx: Ctx, projectId: string, n: Omit<NotifyInput, 'recipientType' | 'recipientId' | 'projectId'>): void {
  const rows = ctx.db
    .prepare(
      `SELECT pa.client_id FROM portal_access pa JOIN projects p ON p.id = pa.project_id
       WHERE pa.project_id = ? AND pa.status = 'active' AND p.portal_status = 'published' AND p.archived_at IS NULL`,
    )
    .all(projectId) as { client_id: string }[];
  for (const r of rows) {
    notify(ctx, {
      ...n,
      recipientType: 'client',
      recipientId: r.client_id,
      projectId,
      dedupeKey: n.dedupeKey ? `${n.dedupeKey}:${r.client_id}` : undefined,
    });
  }
}

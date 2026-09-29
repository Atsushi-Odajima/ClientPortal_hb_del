import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Ctx } from './context.js';
import { notify, notifyProjectClients } from './notify.js';
import { nowIso, todayYmd } from './util.js';

/** 期限超過通知（重複防止キー付き。1日1回まで） */
export function runOverdueCheck(ctx: Ctx): number {
  const { db } = ctx;
  const today = todayYmd();
  let count = 0;
  const reqs = db
    .prepare(
      `SELECT r.id, r.title, r.due_date, p.id project_id, p.owner_id, p.name FROM document_requests r JOIN projects p ON p.id = r.project_id
       WHERE r.status IN ('pending','returned') AND r.due_date IS NOT NULL AND r.due_date < ?
         AND p.archived_at IS NULL AND p.is_sample = 0 AND p.status NOT IN ('completed','cancelled','on_hold')`,
    )
    .all(today) as { id: string; title: string; due_date: string; project_id: string; owner_id: string; name: string }[];
  for (const r of reqs) {
    notify(ctx, {
      ownerId: r.owner_id,
      recipientType: 'operator',
      recipientId: r.owner_id,
      projectId: r.project_id,
      kind: 'overdue',
      title: `期限超過: 資料「${r.title}」（${r.name}）`,
      link: `/app/projects/${r.project_id}?tab=requests`,
      dedupeKey: `overdue:req:${r.id}:${today}`,
    });
    notifyProjectClients(ctx, r.project_id, {
      ownerId: r.owner_id,
      kind: 'overdue',
      title: `ご提出期限を過ぎています: ${r.title}`,
      link: `/portal/p/${r.project_id}/requests`,
      dedupeKey: `overdue:req:${r.id}:${today}`,
    });
    count++;
  }
  const reviews = db
    .prepare(
      `SELECT dv.id, dv.version_number, d.title, d.id deliverable_id, p.id project_id, p.owner_id, p.name FROM deliverable_versions dv
       JOIN deliverables d ON d.id = dv.deliverable_id JOIN projects p ON p.id = dv.project_id
       WHERE dv.status = 'in_review' AND dv.review_due_date IS NOT NULL AND dv.review_due_date < ?
         AND p.archived_at IS NULL AND p.is_sample = 0 AND p.status NOT IN ('completed','cancelled','on_hold')`,
    )
    .all(today) as { id: string; version_number: number; title: string; deliverable_id: string; project_id: string; owner_id: string; name: string }[];
  for (const v of reviews) {
    notify(ctx, {
      ownerId: v.owner_id,
      recipientType: 'operator',
      recipientId: v.owner_id,
      projectId: v.project_id,
      kind: 'overdue',
      title: `確認期限超過: ${v.title} v${v.version_number}（${v.name}）`,
      link: `/app/projects/${v.project_id}/deliverables/${v.deliverable_id}`,
      dedupeKey: `overdue:ver:${v.id}:${today}`,
    });
    notifyProjectClients(ctx, v.project_id, {
      ownerId: v.owner_id,
      kind: 'overdue',
      title: `ご確認期限を過ぎています: ${v.title} v${v.version_number}`,
      link: `/portal/p/${v.project_id}/review/${v.deliverable_id}`,
      dedupeKey: `overdue:ver:${v.id}:${today}`,
    });
    count++;
  }
  const projects = db
    .prepare(
      `SELECT id, owner_id, name FROM projects WHERE due_date IS NOT NULL AND due_date < ? AND archived_at IS NULL AND is_sample = 0
       AND status NOT IN ('delivered','completed','cancelled','on_hold')`,
    )
    .all(today) as { id: string; owner_id: string; name: string }[];
  for (const p of projects) {
    notify(ctx, {
      ownerId: p.owner_id,
      recipientType: 'operator',
      recipientId: p.owner_id,
      projectId: p.id,
      kind: 'overdue',
      title: `納期超過: ${p.name}`,
      link: `/app/projects/${p.id}`,
      dedupeKey: `overdue:prj:${p.id}:${today}`,
    });
    count++;
  }
  return count;
}

/** 期限切れの一時アップロード・セッション・使用済み招待の掃除 */
export async function runCleanup(ctx: Ctx): Promise<void> {
  const { db, cfg } = ctx;
  const now = nowIso();
  const stale = db
    .prepare(`SELECT id FROM uploads WHERE (status IN ('uploading','failed','aborted') AND expires_at < ?) OR (status = 'completed' AND created_at < ?)`)
    .all(now, new Date(Date.now() - 7 * 86400_000).toISOString()) as { id: string }[];
  for (const u of stale) {
    await fsp.rm(path.join(cfg.dataDir, 'tmp', 'uploads', u.id), { recursive: true, force: true });
    db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
  }
  db.prepare('DELETE FROM operator_sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM client_sessions WHERE expires_at < ?').run(now);
  db.prepare(`DELETE FROM invites WHERE kind = 'magic' AND expires_at < ?`).run(new Date(Date.now() - 86400_000).toISOString());
  db.prepare(`DELETE FROM mail_outbox WHERE status = 'sent' AND sent_at < ?`).run(new Date(Date.now() - 30 * 86400_000).toISOString());
}

export function startJobs(ctx: Ctx): () => void {
  const timers: NodeJS.Timeout[] = [];
  const safe = (name: string, fn: () => unknown) => async () => {
    try {
      await fn();
    } catch (e) {
      ctx.log.error({ err: (e as Error).message, job: name }, 'job failed');
    }
  };
  timers.push(setInterval(safe('mail', () => ctx.mailer.flush(ctx.db)), 30_000));
  timers.push(setInterval(safe('overdue', () => runOverdueCheck(ctx)), 60 * 60_000));
  timers.push(setInterval(safe('cleanup', () => runCleanup(ctx)), 60 * 60_000));
  setTimeout(safe('overdue-initial', () => runOverdueCheck(ctx)), 10_000).unref();
  for (const t of timers) t.unref();
  return () => timers.forEach(clearInterval);
}

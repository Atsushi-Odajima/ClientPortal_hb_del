import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor, ClientRow, Ctx, DeliverableRow, OperatorRow, ProjectRow } from '../context.js';
import { audit } from '../audit.js';
import { newId, nowIso, todayYmd } from '../util.js';
import { storeLocalFile } from './fileStore.js';
import { approveVersion, createComment, insertVersion, requestChanges } from './review.js';
import { createInvite } from '../routes/app-projects.js';
import { deleteProjectCompletely } from './deleteProject.js';
import { autoTransition, setProjectStatus } from './projectState.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function sampleAssetDir(): string {
  const candidates = [
    path.resolve(here, '../../assets/sample'), // server/src/services (tsx)
    path.resolve(here, '../../../../server/assets/sample'), // dist/server/src/services (build)
    path.resolve(process.cwd(), 'server/assets/sample'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('sample assets not found');
}

export const SAMPLE_CLIENT_EMAIL = 'sample-client@example.com';

function addDaysYmd(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
}

/**
 * サンプル案件「秋キャンペーンSNS素材制作」を作成。
 * 投稿画像A v1 → ピンコメント2件 → 修正依頼 → v2 → 承認 / 投稿画像B v1 → 承認 / 最終納品（A v2, B v1）
 * すべて is_sample=1 で作成し、ワンクリックで削除できる（本番データと区別）。
 */
export async function createSampleProject(ctx: Ctx, op: OperatorRow) {
  const { db } = ctx;
  const dir = sampleAssetDir();
  const now = nowIso();
  const opActor: Actor & { type: 'operator' } = { type: 'operator', id: op.id, name: op.name };
  const clientId = newId('cli');
  db.prepare(
    `INSERT INTO clients (id, owner_id, company_name, contact_name, email, phone, internal_memo, is_sample, created_at, updated_at)
     VALUES (?, ?, 'Sample Creative株式会社', '見本 花子', ?, '', '【サンプル】内部メモは顧客画面に表示されません', 1, ?, ?)`,
  ).run(clientId, op.id, SAMPLE_CLIENT_EMAIL, now, now);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as ClientRow;
  const cActor: Actor & { type: 'client' } = { type: 'client', id: clientId, name: '見本 花子' };
  const meta = { ipHash: '', userAgent: 'sample' };

  const projectId = newId('prj');
  db.prepare(
    `INSERT INTO projects (id, owner_id, client_id, name, description, start_date, due_date, status, client_guidance, internal_memo, portal_status,
       categories_json, checklist_json, is_sample, created_at, updated_at)
     VALUES (?, ?, ?, '秋キャンペーンSNS素材制作', ?, ?, ?, 'preparing', ?, ?, 'published', ?, ?, 1, ?, ?)`,
  ).run(
    projectId,
    op.id,
    clientId,
    'Instagram用 秋キャンペーン投稿画像2点の制作（サンプル案件）',
    todayYmd(),
    addDaysYmd(21),
    'この案件ページで、資料のご提出・制作物のご確認・承認・納品物の受け取りができます。まずは「やること」をご確認ください。',
    '【サンプル】見積や請求はこのアプリの対象外です（内部メモの例）',
    JSON.stringify(['投稿画像']),
    JSON.stringify(['文言・誤字', '色味', 'ロゴの扱い']),
    now,
    now,
  );
  const p = () => db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow;
  db.prepare(
    `INSERT INTO project_status_history (id, project_id, from_status, to_status, changed_by_type, changed_by_id, changed_at) VALUES (?, ?, NULL, 'preparing', 'operator', ?, ?)`,
  ).run(newId('psh'), projectId, op.id, now);
  audit(db, { ownerId: op.id, projectId, actor: opActor, action: 'project.created', targetType: 'project', targetId: projectId, summary: '秋キャンペーンSNS素材制作（サンプル）' });

  const invite = createInvite(ctx, p(), client, op, 30);
  audit(db, { ownerId: op.id, projectId, actor: opActor, action: 'invite.created', targetType: 'invite', targetId: invite.inviteId, summary: 'Sample Creative株式会社 を招待（サンプル）' });

  // 資料リクエスト
  const reqs: { title: string; kind: string; description: string; required: number }[] = [
    { title: 'ロゴデータ', kind: 'file', description: 'PNG/AI/SVG など', required: 1 },
    { title: '商品写真', kind: 'file', description: 'キャンペーン対象商品の写真', required: 1 },
    { title: '掲載文', kind: 'text', description: '投稿に入れるキャッチコピー', required: 1 },
    { title: 'ブランドカラー', kind: 'text', description: 'カラーコード（例: #C8553D）', required: 0 },
  ];
  const reqIds = reqs.map((r, i) => {
    const id = newId('req');
    db.prepare(
      `INSERT INTO document_requests (id, project_id, title, description, kind, required, due_date, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, r.title, r.description, r.kind, r.required, addDaysYmd(7), i, now, now);
    audit(db, { ownerId: op.id, projectId, actor: opActor, action: 'request.created', targetType: 'request', targetId: id, summary: `資料リクエスト「${r.title}」を追加`, clientVisible: true });
    return id;
  });
  setProjectStatus(ctx, p(), 'waiting_materials', opActor);
  await storeLocalFile(ctx, p(), cActor, path.join(dir, 'logo.png'), 'samplecreative_logo.png', 'request_attachment', { requestId: reqIds[0] });
  await storeLocalFile(ctx, p(), cActor, path.join(dir, 'product.png'), '商品写真_秋限定パッケージ.png', 'request_attachment', { requestId: reqIds[1] });
  const submit = (id: string, title: string, text: string | null) => {
    db.prepare(`UPDATE document_requests SET status = 'submitted', answer_text = ?, submitted_at = ?, submitted_by = ? WHERE id = ?`).run(text, nowIso(), clientId, id);
    audit(db, { ownerId: op.id, projectId, actor: cActor, action: 'request.submitted', targetType: 'request', targetId: id, summary: `「${title}」を提出`, clientVisible: true });
  };
  submit(reqIds[0], 'ロゴデータ', null);
  submit(reqIds[1], '商品写真', null);
  submit(reqIds[2], '掲載文', '実りの秋、ごほうび時間。秋限定パッケージ登場');
  for (const [i, title] of [[0, 'ロゴデータ'], [1, '商品写真'], [2, '掲載文']] as const) {
    db.prepare(`UPDATE document_requests SET status = 'accepted', reviewed_at = ? WHERE id = ?`).run(nowIso(), reqIds[i]);
    audit(db, { ownerId: op.id, projectId, actor: opActor, action: 'request.accepted', targetType: 'request', targetId: reqIds[i], summary: `「${title}」を確認しました`, clientVisible: true });
  }
  setProjectStatus(ctx, p(), 'in_production', opActor);

  // 制作物
  const mkDeliverable = (title: string, order: number): DeliverableRow => {
    const id = newId('dlv');
    db.prepare('INSERT INTO deliverables (id, project_id, title, category, description, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      projectId,
      title,
      '投稿画像',
      'Instagramフィード投稿用（1080×1080）',
      order,
      now,
      now,
    );
    return db.prepare('SELECT * FROM deliverables WHERE id = ?').get(id) as DeliverableRow;
  };
  const dA = mkDeliverable('投稿画像A', 0);
  const dB = mkDeliverable('投稿画像B', 1);
  const fA1 = await storeLocalFile(ctx, p(), opActor, path.join(dir, 'post-a-v1.png'), '投稿画像A.png', 'deliverable_version', { versionGroupId: dA.id, versionNumber: 1 });
  const vA1 = insertVersion(ctx, p(), dA, fA1, opActor, { note: '初稿です。文字の大きさと色味をご確認ください。', checklist: ['文言・誤字', '色味'], reviewDueDate: addDaysYmd(3) });
  const fB1 = await storeLocalFile(ctx, p(), opActor, path.join(dir, 'post-b-v1.png'), '投稿画像B.png', 'deliverable_version', { versionGroupId: dB.id, versionNumber: 1 });
  const vB1 = insertVersion(ctx, p(), dB, fB1, opActor, { note: '初稿です。', checklist: ['文言・誤字'], reviewDueDate: addDaysYmd(3) });

  createComment(ctx, p(), cActor, vA1.id, { body: 'キャッチコピーをもう少し大きくしてください', pin: { x: 0.5, y: 0.19 } }, meta);
  createComment(ctx, p(), cActor, vA1.id, { body: 'ロゴをもう少し右下に寄せてほしいです', pin: { x: 0.7, y: 0.78 } }, meta);
  requestChanges(ctx, p(), { id: clientId, name: '見本 花子' }, vA1.id, 'ピン2か所の修正をお願いします。', meta);
  db.prepare(`UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE version_id = ?`).run(nowIso(), `operator:${op.id}`, vA1.id);

  const fA2 = await storeLocalFile(ctx, p(), opActor, path.join(dir, 'post-a-v2.png'), '投稿画像A.png', 'deliverable_version', { versionGroupId: dA.id, versionNumber: 2 });
  const vA2 = insertVersion(ctx, p(), dA, fA2, opActor, { note: 'ご指摘の2点を修正しました。', checklist: ['文言・誤字', '色味'], reviewDueDate: addDaysYmd(3) });
  approveVersion(ctx, p(), { id: clientId, name: '見本 花子' }, { versionId: vA2.id, idempotencyKey: `sample:${newId('k')}`, comment: 'この内容でお願いします', expectedVersionNumber: 2 }, meta);
  const apB = approveVersion(ctx, p(), { id: clientId, name: '見本 花子' }, { versionId: vB1.id, idempotencyKey: `sample:${newId('k')}`, comment: '', expectedVersionNumber: 1 }, meta);
  void apB;

  // 最終納品
  const deliveryId = newId('dly');
  db.prepare(
    `INSERT INTO deliveries (id, project_id, title, description, notice, status, published_at, created_at, updated_at) VALUES (?, ?, '最終納品', ?, ?, 'published', ?, ?, ?)`,
  ).run(deliveryId, projectId, '承認いただいた投稿画像2点です。', '投稿以外の用途（印刷物等）でご利用の場合はご相談ください。', nowIso(), now, now);
  [vA2, vB1].forEach((v, i) => {
    const ap = db.prepare('SELECT id FROM approvals WHERE version_id = ? AND revoked_at IS NULL').get(v.id) as { id: string };
    db.prepare('INSERT INTO delivery_items (id, delivery_id, version_id, approval_id, file_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(newId('dli'), deliveryId, v.id, ap.id, v.file_id, i);
  });
  audit(db, { ownerId: op.id, projectId, actor: opActor, action: 'delivery.published', targetType: 'delivery', targetId: deliveryId, summary: '納品「最終納品」を公開（2件）', clientVisible: true });
  autoTransition(ctx, projectId, 'delivery_published');
  // サンプルの通知は既読にしておく
  db.prepare('UPDATE notifications SET read_at = ? WHERE project_id = ?').run(nowIso(), projectId);
  return { projectId, clientId, inviteUrl: invite.url, clientEmail: SAMPLE_CLIENT_EMAIL, inviteExpiresAt: invite.expiresAt };
}

export async function deleteSampleData(ctx: Ctx, op: OperatorRow) {
  const { db } = ctx;
  const projects = db.prepare('SELECT * FROM projects WHERE owner_id = ? AND is_sample = 1').all(op.id) as ProjectRow[];
  for (const p of projects) await deleteProjectCompletely(ctx, p, { type: 'operator', id: op.id, name: op.name });
  const clients = db.prepare('SELECT id FROM clients WHERE owner_id = ? AND is_sample = 1').all(op.id) as { id: string }[];
  for (const c of clients) {
    const n = (db.prepare('SELECT COUNT(*) n FROM projects WHERE client_id = ?').get(c.id) as { n: number }).n;
    if (n > 0) continue;
    db.prepare('DELETE FROM client_sessions WHERE client_id = ?').run(c.id);
    db.prepare(`DELETE FROM notifications WHERE recipient_type = 'client' AND recipient_id = ?`).run(c.id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(c.id);
  }
  return { deletedProjects: projects.length, deletedClients: clients.length };
}

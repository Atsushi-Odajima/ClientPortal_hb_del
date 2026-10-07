import crypto from 'node:crypto';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Agent, PDF, PNG, PNG2, PNG3, createClientAndProject, idem, inviteClient, makeApp, newOperator, submitVersion, upload } from './helpers.js';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

let app: FastifyInstance;
let op: Agent;
let client: Agent;
let projectId: string;

beforeAll(async () => {
  ({ app } = await makeApp());
  op = await newOperator(app);
  const r = await createClientAndProject(op);
  projectId = r.projectId;
  client = (await inviteClient(app, op, projectId, r.email)).client;
});
afterAll(async () => app.close());

async function newDeliverable(title: string) {
  return (await op.post(`/api/app/projects/${projectId}/deliverables`, { title })).body.id as string;
}

describe('資料リクエスト', () => {
  it('5種類の提出・3/5表示・アップロードだけでは確認済みにならない・差戻し→再提出→確認', async () => {
    const ids: Record<string, string> = {};
    for (const [kind, extra] of [
      ['file', {}],
      ['text', {}],
      ['url', {}],
      ['choice', { choices: ['A案', 'B案'] }],
      ['check', {}],
    ] as const) {
      const r = await op.post(`/api/app/projects/${projectId}/requests`, { title: `req-${kind}`, kind, ...extra });
      expect(r.status).toBe(200);
      ids[kind] = r.body.id;
    }
    // ファイル種別: アップロードのみ → 未提出のまま
    await upload(client, `/api/portal/projects/${projectId}/uploads`, 'logo.png', PNG(), { requestId: ids.file });
    let reqs = (await client.get(`/api/portal/projects/${projectId}/requests`)).body.requests;
    expect(reqs.find((r: { id: string }) => r.id === ids.file).status).toBe('pending');
    // 入力検証
    expect((await client.post(`/api/portal/projects/${projectId}/requests/${ids.url}/submit`, { url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await client.post(`/api/portal/projects/${projectId}/requests/${ids.choice}/submit`, { choice: 'C案' })).status).toBe(400);
    expect((await client.post(`/api/portal/projects/${projectId}/requests/${ids.check}/submit`, { checked: false })).status).toBe(400);
    expect((await client.post(`/api/portal/projects/${projectId}/requests/${ids.text}/submit`, { text: '  ' })).status).toBe(400);
    // 提出
    expect((await client.post(`/api/portal/projects/${projectId}/requests/${ids.file}/submit`, {})).status).toBe(200);
    expect((await client.post(`/api/portal/projects/${projectId}/requests/${ids.text}/submit`, { text: 'プロフィール文' })).status).toBe(200);
    expect((await client.post(`/api/portal/projects/${projectId}/requests/${ids.url}/submit`, { url: 'https://example.com/ref' })).status).toBe(200);
    const home = await client.get(`/api/portal/projects/${projectId}`);
    expect(home.body.todo.requests).toMatchObject({ total: 5, submitted: 3, accepted: 0 });
    expect(home.body.todo.requests.toSubmit.map((r: { id: string }) => r.id).sort()).toEqual([ids.choice, ids.check].sort());
    // 二重提出は不可
    expect((await client.post(`/api/portal/projects/${projectId}/requests/${ids.text}/submit`, { text: 'x' })).status).toBe(409);
    // 運営者: 確認済み・差戻し
    expect((await op.post(`/api/app/projects/${projectId}/requests/${ids.file}/review`, { decision: 'accept' })).status).toBe(200);
    expect((await op.post(`/api/app/projects/${projectId}/requests/${ids.text}/review`, { decision: 'return', reason: '' })).status).toBe(400);
    expect((await op.post(`/api/app/projects/${projectId}/requests/${ids.text}/review`, { decision: 'return', reason: 'もう少し詳しく' })).status).toBe(200);
    reqs = (await client.get(`/api/portal/projects/${projectId}/requests`)).body.requests;
    const t = reqs.find((r: { id: string }) => r.id === ids.text);
    expect(t).toMatchObject({ status: 'returned', returnReason: 'もう少し詳しく' });
    expect((await client.post(`/api/portal/projects/${projectId}/requests/${ids.text}/submit`, { text: '詳しいプロフィール文' })).status).toBe(200);
    expect((await op.post(`/api/app/projects/${projectId}/requests/${ids.text}/review`, { decision: 'accept' })).status).toBe(200);
    // 運営者ダッシュボードの顧客待ち
    const dash = await op.get('/api/app/dashboard');
    expect(dash.body.clientTurn.waitingMaterials.map((i: { targetId: string }) => i.targetId).sort()).toEqual([ids.choice, ids.check].sort());
    expect(dash.body.myTurn.toReviewMaterials.map((i: { targetId: string }) => i.targetId)).toContain(ids.url);
    // 通知
    const n = await op.get('/api/app/notifications');
    expect(n.body.notifications.some((x: { kind: string }) => x.kind === 'request_submitted')).toBe(true);
    const cn = await client.get('/api/portal/notifications');
    expect(cn.body.notifications.some((x: { kind: string }) => x.kind === 'request_returned')).toBe(true);
  });
});

describe('制作物version管理', () => {
  it('v1→v2→v3、旧版保持、最新版表示', async () => {
    const did = await newDeliverable('バナーA');
    // 版なしの制作物は顧客に見えない
    expect((await client.get(`/api/portal/projects/${projectId}/deliverables`)).body.deliverables.find((d: { id: string }) => d.id === did)).toBeUndefined();
    const v1 = await submitVersion(op, projectId, did, PNG(), 'banner.png', '初稿');
    const v2 = await submitVersion(op, projectId, did, PNG2(), 'banner.png', '修正版');
    const v3 = await submitVersion(op, projectId, did, PNG3(), 'banner.png', '再修正版');
    expect([v1.status, v2.status, v3.status]).toEqual([200, 200, 200]);
    const d = (await client.get(`/api/portal/projects/${projectId}/deliverables/${did}`)).body.deliverable;
    expect(d.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([3, 2, 1]);
    expect(d.versions[0]).toMatchObject({ isLatest: true, status: 'in_review', note: '再修正版' });
    expect(d.versions[1]).toMatchObject({ isLatest: false, status: 'superseded' });
    expect(d.versions[2]).toMatchObject({ isLatest: false, status: 'superseded' });
    // 同名ファイルでも別実体として保持（上書きしない）
    expect(new Set(d.versions.map((v: { file: { sha256: string } }) => v.file.sha256)).size).toBe(3);
    const old = await client.get(`${d.versions[2].file.url}`);
    expect(old.raw.equals(PNG())).toBe(true);
    // versionGroupId / versionNumber を保持
    const f = app.ctx.db.prepare('SELECT version_group_id, version_number FROM files WHERE id = ?').get(d.versions[0].file.id);
    expect(f).toEqual({ version_group_id: did, version_number: 3 });
  });

  it('提出済みversionのファイルはDBレベルで差替え不可', () => {
    const v = app.ctx.db.prepare('SELECT id FROM deliverable_versions LIMIT 1').get() as { id: string };
    expect(() => app.ctx.db.prepare(`UPDATE deliverable_versions SET file_id = 'fil_x' WHERE id = ?`).run(v.id)).toThrow(/immutable/);
  });
});

describe('コメント・画像ピン・修正依頼', () => {
  let did: string;
  let v1: string;
  it('通常コメント・ピン2件・返信・編集・削除・解決', async () => {
    did = await newDeliverable('投稿画像A');
    v1 = (await submitVersion(op, projectId, did, PNG())).body.versionId;
    const c1 = await client.post(`/api/portal/projects/${projectId}/versions/${v1}/comments`, { body: '全体的に良いです' });
    expect(c1.status).toBe(200);
    const p1 = await client.post(`/api/portal/projects/${projectId}/versions/${v1}/comments`, { body: '文字を大きく', pin: { x: 0.5, y: 0.2 } });
    const p2 = await client.post(`/api/portal/projects/${projectId}/versions/${v1}/comments`, { body: 'ロゴ位置', pin: { x: 0.81234, y: 0.9 } });
    expect([p1.body.pinNumber, p2.body.pinNumber]).toEqual([1, 2]);
    // 範囲外座標は拒否
    expect((await client.post(`/api/portal/projects/${projectId}/versions/${v1}/comments`, { body: 'x', pin: { x: 1.2, y: 0.5 } })).status).toBe(400);
    // 運営者の返信
    const reply = await op.post(`/api/app/projects/${projectId}/versions/${v1}/comments`, { body: '承知しました', parentId: p1.body.id });
    expect(reply.status).toBe(200);
    // 他人のコメントは編集不可
    expect((await op.patch(`/api/app/projects/${projectId}/comments/${p1.body.id}`, { body: 'x' })).status).toBe(403);
    expect((await client.patch(`/api/portal/projects/${projectId}/comments/${c1.body.id}`, { body: '全体的にとても良いです' })).status).toBe(200);
    expect((await client.del(`/api/portal/projects/${projectId}/comments/${c1.body.id}`)).status).toBe(200);
    expect((await op.post(`/api/app/projects/${projectId}/comments/${reply.body.id}/resolve`, { resolved: true })).status).toBe(200);
    const d = (await client.get(`/api/portal/projects/${projectId}/deliverables/${did}`)).body;
    const cs = d.comments[v1];
    const pins = cs.filter((c: { pin: unknown }) => c.pin);
    expect(pins).toHaveLength(2);
    // 相対座標がそのまま保存・返却される（画面サイズ非依存）
    expect(pins[1].pin).toEqual({ x: 0.81234, y: 0.9, number: 2, type: 'change', typeLabel: '変更' });
    const deleted = cs.find((c: { id: string }) => c.id === c1.body.id);
    expect(deleted).toMatchObject({ deleted: true, body: '', edited: true });
    expect(cs.find((c: { id: string }) => c.id === reply.body.id).resolved).toBe(true);
  });

  it('画像以外にはピンを付けられない', async () => {
    const pdfDid = await newDeliverable('資料PDF');
    const v = (await submitVersion(op, projectId, pdfDid, PDF(), 'doc.pdf')).body.versionId;
    const r = await client.post(`/api/portal/projects/${projectId}/versions/${v}/comments`, { body: 'x', pin: { x: 0.1, y: 0.1 } });
    expect(r.status).toBe(400);
    expect((await client.post(`/api/portal/projects/${projectId}/versions/${v}/comments`, { body: '通常コメントは可' })).status).toBe(200);
  });

  it('修正依頼は固定記録され、新versionで差戻し理由が保持される', async () => {
    const r = await client.post(`/api/portal/projects/${projectId}/versions/${v1}/change-request`, { body: 'ピンの2点を修正してください' });
    expect(r.status).toBe(200);
    const row = app.ctx.db.prepare('SELECT * FROM change_requests WHERE id = ?').get(r.body.id) as { version_id: string; client_name: string; body: string; pin_comment_ids_json: string };
    expect(row.version_id).toBe(v1);
    expect(JSON.parse(row.pin_comment_ids_json)).toHaveLength(2);
    expect(() => app.ctx.db.prepare(`UPDATE change_requests SET body = 'x' WHERE id = ?`).run(r.body.id)).toThrow(/immutable/);
    const dash = await op.get('/api/app/dashboard');
    expect(dash.body.myTurn.changeRequested.map((i: { targetId: string }) => i.targetId)).toContain(did);
    const opN = await op.get('/api/app/notifications');
    expect(opN.body.notifications.some((n: { kind: string }) => n.kind === 'change_request')).toBe(true);
    const v2 = (await submitVersion(op, projectId, did, PNG2(), 'a.png', '修正しました')).body.versionId;
    const d = (await client.get(`/api/portal/projects/${projectId}/deliverables/${did}`)).body.deliverable;
    const old = d.versions.find((v: { id: string }) => v.id === v1);
    expect(old.status).toBe('superseded');
    expect(old.changeRequests[0].body).toBe('ピンの2点を修正してください');
    expect(d.versions[0].id).toBe(v2);
    // 旧版への修正依頼は不可
    const stale = await client.post(`/api/portal/projects/${projectId}/versions/${v1}/change-request`, { body: 'x' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale_version');
  });
});

describe('承認', () => {
  it('最新版承認・二重クリック・通信再送・ハッシュ記録', async () => {
    const did = await newDeliverable('投稿画像B');
    const v1 = (await submitVersion(op, projectId, did, PNG3())).body.versionId;
    const key = idem();
    // 同時に2回（二重クリック）
    const [a, b] = await Promise.all([
      client.post(`/api/portal/projects/${projectId}/versions/${v1}/approve`, { idempotencyKey: key, expectedVersionNumber: 1, confirm: true }),
      client.post(`/api/portal/projects/${projectId}/versions/${v1}/approve`, { idempotencyKey: key, expectedVersionNumber: 1, confirm: true }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.approval.id).toBe(b.body.approval.id);
    // 通信再送（別キー）でも重複しない
    const c = await client.post(`/api/portal/projects/${projectId}/versions/${v1}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 1, confirm: true });
    expect(c.status).toBe(200);
    expect(c.body.duplicate).toBe(true);
    const n = (app.ctx.db.prepare('SELECT COUNT(*) n FROM approvals WHERE version_id = ?').get(v1) as { n: number }).n;
    expect(n).toBe(1);
    expect(a.body.approval.fileSha256).toBe(sha(PNG3()));
    // 確認チェックなしは拒否
    const did2 = await newDeliverable('X');
    const vx = (await submitVersion(op, projectId, did2, PNG())).body.versionId;
    expect((await client.post(`/api/portal/projects/${projectId}/versions/${vx}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 1 })).status).toBe(400);
    // DBレベルでも有効な承認は1版1件
    expect(() =>
      app.ctx.db
        .prepare(`INSERT INTO approvals (id, project_id, deliverable_id, version_id, version_number, client_id, client_name, file_id, file_sha256, idempotency_key, approved_at) SELECT 'apr_dup', project_id, deliverable_id, version_id, version_number, client_id, client_name, file_id, file_sha256, 'dupkey', approved_at FROM approvals WHERE version_id = ?`)
        .run(v1),
    ).toThrow(/UNIQUE/);
    expect(() => app.ctx.db.prepare(`UPDATE approvals SET file_sha256 = 'x' WHERE version_id = ?`).run(v1)).toThrow(/immutable/);
  });

  it('旧版の誤承認防止・新versionで承認を引継がず再承認が必要', async () => {
    const did = await newDeliverable('LP');
    const v1 = (await submitVersion(op, projectId, did, PNG())).body.versionId;
    const ok = await client.post(`/api/portal/projects/${projectId}/versions/${v1}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 1, confirm: true });
    expect(ok.status).toBe(200);
    // v1 承認後に v2 提出
    const v2 = (await submitVersion(op, projectId, did, PNG2())).body.versionId;
    let d = (await client.get(`/api/portal/projects/${projectId}/deliverables/${did}`)).body.deliverable;
    expect(d.status).toBe('in_review');
    expect(d.versions[0]).toMatchObject({ id: v2, approval: null, status: 'in_review' });
    // v1 の承認は履歴として残る（v1に紐づく）
    expect(d.versions[1].approval).toMatchObject({ versionNumber: 1 });
    // 顧客のやること に v2 が出る
    const home = await client.get(`/api/portal/projects/${projectId}`);
    expect(home.body.todo.reviews.map((r: { versionId: string }) => r.versionId)).toContain(v2);
    // 古い画面から v1 を承認しようとしても拒否
    const stale = await client.post(`/api/portal/projects/${projectId}/versions/${v1}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 1, confirm: true });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'stale_version', latestVersionId: v2, latestVersionNumber: 2 });
    // v2 を承認するときに古いversion番号を期待していたら拒否
    const wrongExpect = await client.post(`/api/portal/projects/${projectId}/versions/${v2}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 1, confirm: true });
    expect(wrongExpect.status).toBe(409);
    const ok2 = await client.post(`/api/portal/projects/${projectId}/versions/${v2}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 2, confirm: true });
    expect(ok2.status).toBe(200);
    d = (await client.get(`/api/portal/projects/${projectId}/deliverables/${did}`)).body.deliverable;
    expect(d.status).toBe('approved');
  });

  it('承認取消は履歴を残し、再承認可能', async () => {
    const did = await newDeliverable('名刺');
    const v1 = (await submitVersion(op, projectId, did, PNG())).body.versionId;
    const a = await client.post(`/api/portal/projects/${projectId}/versions/${v1}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 1, confirm: true });
    expect((await client.post(`/api/portal/projects/${projectId}/approvals/${a.body.approval.id}/revoke`, { reason: '' })).status).toBe(400);
    expect((await client.post(`/api/portal/projects/${projectId}/approvals/${a.body.approval.id}/revoke`, { reason: '社内で再検討' })).status).toBe(200);
    expect((await client.post(`/api/portal/projects/${projectId}/approvals/${a.body.approval.id}/revoke`, { reason: 'again' })).status).toBe(409);
    const row = app.ctx.db.prepare('SELECT * FROM approvals WHERE id = ?').get(a.body.approval.id) as { revoked_at: string; revoke_reason: string };
    expect(row.revoked_at).toBeTruthy();
    expect(row.revoke_reason).toBe('社内で再検討');
    const d = (await client.get(`/api/portal/projects/${projectId}/deliverables/${did}`)).body.deliverable;
    expect(d.versions[0].status).toBe('in_review');
    expect(d.versions[0].approvalHistory).toHaveLength(1);
    const again = await client.post(`/api/portal/projects/${projectId}/versions/${v1}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 1, confirm: true });
    expect(again.status).toBe(200);
    expect(again.body.approval.id).not.toBe(a.body.approval.id);
    const acts = (await client.get(`/api/portal/projects/${projectId}/activity`)).body.events.map((e: { action: string }) => e.action);
    expect(acts).toContain('approval.revoked');
  });
});

describe('最終納品・ZIP', () => {
  it('承認済み最新版だけ選択可・ZIPに他案件/内部/旧版が混入しない・期限・ダウンロード履歴', async () => {
    // 別案件（同じ運営者）にもファイルを置く
    const other = await createClientAndProject(op);
    const otherDid = (await op.post(`/api/app/projects/${other.projectId}/deliverables`, { title: 'OTHER' })).body.id;
    const otherV = (await submitVersion(op, other.projectId, otherDid, PNG3(), 'other.png')).body.versionId;
    // 内部ファイル
    await upload(op, `/api/app/projects/${projectId}/uploads`, 'internal-work.psd.png', PNG(), { target: { purpose: 'internal' } });

    const dA = await newDeliverable('投稿画像A/../../evil');
    const a1 = (await submitVersion(op, projectId, dA, PNG(), 'A.png')).body.versionId;
    const a2 = (await submitVersion(op, projectId, dA, PNG2(), 'A.png')).body.versionId;
    await client.post(`/api/portal/projects/${projectId}/versions/${a2}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 2, confirm: true });
    const dB = await newDeliverable('投稿画像B');
    const b1 = (await submitVersion(op, projectId, dB, PNG3(), 'B.png')).body.versionId;
    await client.post(`/api/portal/projects/${projectId}/versions/${b1}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 1, confirm: true });
    const dC = await newDeliverable('未承認');
    const c1 = (await submitVersion(op, projectId, dC, PNG(), 'C.png')).body.versionId;

    // 未承認・旧版・他案件は選べない
    expect((await op.post(`/api/app/projects/${projectId}/deliveries`, { title: 'x', versionIds: [c1] })).status).toBe(409);
    expect((await op.post(`/api/app/projects/${projectId}/deliveries`, { title: 'x', versionIds: [a1] })).status).toBe(409);
    expect((await op.post(`/api/app/projects/${projectId}/deliveries`, { title: 'x', versionIds: [otherV] })).status).toBe(404);
    const cand = await op.get(`/api/app/projects/${projectId}/delivery-candidates`);
    expect(cand.body.candidates.find((c: { versionId: string }) => c.versionId === c1).approved).toBe(false);

    const del = await op.post(`/api/app/projects/${projectId}/deliveries`, { title: '最終納品', notice: '注意', versionIds: [a2, b1] });
    expect(del.status).toBe(200);
    const did = del.body.id;
    // 追加の納品ファイル
    const extra = await upload(op, `/api/app/projects/${projectId}/uploads`, 'source.zip', Buffer.from('PK\u0003\u0004' + 'x'.repeat(100)), { target: { purpose: 'delivery_extra', deliveryId: did } });
    expect(extra.status).toBe(200);
    // 公開前は顧客から見えない
    expect((await client.get(`/api/portal/projects/${projectId}/deliveries`)).body.deliveries.find((d: { id: string }) => d.id === did)).toBeUndefined();
    expect((await client.get(`/api/portal/projects/${projectId}/files/${extra.body.file.id}/content`)).status).toBe(404);
    expect((await op.post(`/api/app/projects/${projectId}/deliveries/${did}/publish`, { confirm: true })).status).toBe(200);
    // 公開後の変更は不可
    expect((await op.patch(`/api/app/projects/${projectId}/deliveries/${did}`, { versionIds: [a2] })).status).toBe(409);
    // 公開中の納品に含まれる承認は取消不可
    const apA = (app.ctx.db.prepare('SELECT id FROM approvals WHERE version_id = ? AND revoked_at IS NULL').get(a2) as { id: string }).id;
    expect((await client.post(`/api/portal/projects/${projectId}/approvals/${apA}/revoke`, { reason: 'x' })).status).toBe(409);

    const list = await client.get(`/api/portal/projects/${projectId}/deliveries`);
    const dl = list.body.deliveries.find((d: { id: string }) => d.id === did);
    expect(dl.items).toHaveLength(3);
    const zip = await client.get(dl.zipUrl);
    expect(zip.status).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    const entries = unzipSync(new Uint8Array(zip.raw));
    const names = Object.keys(entries).sort();
    expect(names).toEqual(['最終納品/source.zip', '最終納品/投稿画像A_.._.._evil_v2.png', '最終納品/投稿画像B_v1.png'].sort());
    for (const n of names) expect(n.startsWith('最終納品/')).toBe(true);
    expect(sha(Buffer.from(entries['最終納品/投稿画像A_.._.._evil_v2.png']))).toBe(sha(PNG2()));
    expect(sha(Buffer.from(entries['最終納品/投稿画像B_v1.png']))).toBe(sha(PNG3()));
    // 個別ダウンロード＋履歴
    const one = await client.get(dl.items[0].file.downloadUrl);
    expect(one.status).toBe(200);
    const acts = (await op.get(`/api/app/projects/${projectId}/activity`)).body.events.map((e: { action: string }) => e.action);
    expect(acts).toContain('delivery.zip_downloaded');
    expect(acts).toContain('delivery.downloaded');
    // 期限切れ
    await op.patch(`/api/app/projects/${projectId}/deliveries/${did}`, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect((await client.get(dl.zipUrl)).status).toBe(410);
    expect((await client.get(dl.items[2].file.downloadUrl)).status).toBe(410);
    // 取り下げ後は見えない
    await op.patch(`/api/app/projects/${projectId}/deliveries/${did}`, { expiresAt: null });
    await op.post(`/api/app/projects/${projectId}/deliveries/${did}/withdraw`);
    expect((await client.get(dl.zipUrl)).status).toBe(404);
    expect((await client.get(`/api/portal/projects/${projectId}/files/${extra.body.file.id}/content`)).status).toBe(404);
  });
});

describe('テンプレート', () => {
  it('テンプレートから案件作成、後編集で既存案件は変わらない', async () => {
    const t = await op.get('/api/app/templates');
    expect(t.body.templates.length).toBeGreaterThanOrEqual(5);
    const tpl = await op.post('/api/app/templates', {
      name: '独自テンプレ',
      clientGuidance: '案内文',
      requests: [
        { title: 'ロゴ', kind: 'file' },
        { title: '色', kind: 'choice', choices: ['赤', '青'] },
      ],
      categories: ['バナー'],
      checklist: ['誤字'],
    });
    const clientId = (await op.get('/api/app/clients')).body.clients[0].id;
    const p = await op.post('/api/app/projects', { clientId, name: 'テンプレ案件', templateId: tpl.body.id });
    await op.patch(`/api/app/templates/${tpl.body.id}`, { name: '独自テンプレ2', requests: [{ title: '別物', kind: 'text' }] });
    const d = await op.get(`/api/app/projects/${p.body.id}`);
    expect(d.body.requests.map((r: { title: string }) => r.title)).toEqual(['ロゴ', '色']);
    expect(d.body.project.clientGuidance).toBe('案内文');
    expect(d.body.project.checklist).toEqual(['誤字']);
  });
});

describe('検索・絞込', () => {
  it('案件名・顧客名・ファイル名・制作物名で検索、状態で絞込', async () => {
    const s = await op.get(`/api/app/search?q=${encodeURIComponent('投稿画像')}`);
    expect(s.body.deliverables.length).toBeGreaterThan(0);
    const f = await op.get(`/api/app/search?q=${encodeURIComponent('A.png')}`);
    expect(f.body.files.length).toBeGreaterThan(0);
    const c = await op.get(`/api/app/search?q=${encodeURIComponent('テスト株式会社')}`);
    expect(c.body.clients.length).toBeGreaterThan(0);
    const pending = await op.get('/api/app/projects?approval=pending');
    expect(pending.body.projects.map((p: { id: string }) => p.id)).toContain(projectId);
    const pr = await op.get('/api/app/projects?pendingRequests=1');
    expect(pr.body.projects.map((p: { id: string }) => p.id)).toContain(projectId);
    const st = await op.get('/api/app/projects?status=completed');
    expect(st.body.projects).toHaveLength(0);
    // LIKE のワイルドカードは無害化
    expect((await op.get(`/api/app/search?q=${encodeURIComponent('%')}`)).body.projects).toHaveLength(0);
  });
});

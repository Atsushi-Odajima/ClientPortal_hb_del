import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Agent, PNG, createClientAndProject, idem, inviteClient, makeApp, newOperator, submitVersion, upload } from './helpers.js';

/**
 * データ分離テスト: 運営者A/B、顧客A/B。URL中のIDを差し替えても他者のデータに届かないこと。
 */
let app: FastifyInstance;
let opA: Agent, opB: Agent;
let A: { projectId: string; clientId: string; email: string };
let B: { projectId: string; clientId: string; email: string };
let clientA: Agent, clientB: Agent;
let tokenA: string;
let fileA: string, deliverableA: string, versionA: string, requestA: string, internalFileA: string, deliveryA: string;

beforeAll(async () => {
  ({ app } = await makeApp());
  opA = await newOperator(app, 'OpA');
  opB = await newOperator(app, 'OpB');
  A = await createClientAndProject(opA);
  B = await createClientAndProject(opB);
  const ia = await inviteClient(app, opA, A.projectId, A.email);
  clientA = ia.client;
  tokenA = ia.token;
  clientB = (await inviteClient(app, opB, B.projectId, B.email)).client;
  requestA = (await opA.post(`/api/app/projects/${A.projectId}/requests`, { title: 'ロゴ', kind: 'file' })).body.id;
  const up = await upload(clientA, `/api/portal/projects/${A.projectId}/uploads`, 'logo.png', PNG(), { requestId: requestA });
  fileA = up.body.file.id;
  deliverableA = (await opA.post(`/api/app/projects/${A.projectId}/deliverables`, { title: 'バナー' })).body.id;
  versionA = (await submitVersion(opA, A.projectId, deliverableA, PNG())).body.versionId;
  internalFileA = (await upload(opA, `/api/app/projects/${A.projectId}/uploads`, 'work.png', PNG(), { target: { purpose: 'internal' } })).body.file.id;
  await clientA.post(`/api/portal/projects/${A.projectId}/versions/${versionA}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 1, confirm: true });
  deliveryA = (await opA.post(`/api/app/projects/${A.projectId}/deliveries`, { title: '納品', versionIds: [versionA] })).body.id;
});
afterAll(async () => app.close());

describe('運営者A → 運営者Bのデータ', () => {
  it('案件・顧客・ファイル・制作物・納品・監査は404', async () => {
    const urls = [
      `/api/app/projects/${A.projectId}`,
      `/api/app/projects/${A.projectId}/activity`,
      `/api/app/clients/${A.clientId}`,
      `/api/app/projects/${A.projectId}/files/${fileA}/content`,
      `/api/app/projects/${A.projectId}/files/${fileA}/content?dl=1`,
      `/api/app/projects/${A.projectId}/deliverables/${deliverableA}`,
      `/api/app/projects/${A.projectId}/deliveries/${deliveryA}`,
      `/api/app/projects/${A.projectId}/deliveries/${deliveryA}/zip`,
      `/api/app/projects/${A.projectId}/delivery-candidates`,
      // 自分の案件IDに他者のファイルIDを組み合わせる
      `/api/app/projects/${B.projectId}/files/${fileA}/content`,
      `/api/app/projects/${B.projectId}/deliverables/${deliverableA}`,
    ];
    for (const u of urls) {
      const r = await opB.get(u);
      expect(r.status, u).toBe(404);
    }
  });

  it('更新系も404（状態・招待・資料・コメント・承認取消・アップロード）', async () => {
    const calls: [string, string, unknown][] = [
      ['PATCH', `/api/app/projects/${A.projectId}`, { name: 'hacked' }],
      ['POST', `/api/app/projects/${A.projectId}/status`, { status: 'completed' }],
      ['POST', `/api/app/projects/${A.projectId}/invites`, { days: 7 }],
      ['POST', `/api/app/projects/${A.projectId}/requests`, { title: 'x', kind: 'text' }],
      ['POST', `/api/app/projects/${A.projectId}/requests/${requestA}/review`, { decision: 'accept' }],
      ['POST', `/api/app/projects/${A.projectId}/versions/${versionA}/comments`, { body: 'x' }],
      ['POST', `/api/app/projects/${B.projectId}/versions/${versionA}/comments`, { body: 'x' }],
      ['POST', `/api/app/projects/${A.projectId}/uploads`, { name: 'a.png', size: 10, target: { purpose: 'internal' } }],
      ['POST', `/api/app/projects/${B.projectId}/uploads`, { name: 'a.png', size: 10, target: { purpose: 'deliverable_version', deliverableId: deliverableA } }],
      ['PATCH', `/api/app/clients/${A.clientId}`, { companyName: 'x' }],
      ['POST', `/api/app/clients/${A.clientId}/suspend-access`, {}],
      ['DELETE', `/api/app/projects/${A.projectId}`, { confirmName: 'テスト案件' }],
    ];
    for (const [m, u, b] of calls) {
      const r = await opB.req(m, u, b);
      expect(r.status, `${m} ${u}`).toBe(404);
    }
    // 名前が変わっていないこと
    expect((await opA.get(`/api/app/projects/${A.projectId}`)).body.project.name).toBe('テスト案件');
  });

  it('一覧・検索・ダッシュボード・通知に他者データが出ない', async () => {
    const list = await opB.get('/api/app/projects');
    expect(list.body.projects.map((p: { id: string }) => p.id)).not.toContain(A.projectId);
    const s = await opB.get(`/api/app/search?q=${encodeURIComponent('テスト')}`);
    expect(s.body.projects.map((p: { id: string }) => p.id)).not.toContain(A.projectId);
    expect(s.body.files.map((f: { id: string }) => f.id)).not.toContain(fileA);
    const clients = await opB.get('/api/app/clients');
    expect(clients.body.clients.map((c: { id: string }) => c.id)).not.toContain(A.clientId);
    const audit = await opB.get('/api/app/audit');
    expect(audit.body.events.every((e: { projectId: string | null }) => e.projectId !== A.projectId)).toBe(true);
  });
});

describe('顧客B → 顧客Aの案件', () => {
  it('他案件ID・ファイルID・制作物IDは404', async () => {
    const urls = [
      `/api/portal/projects/${A.projectId}`,
      `/api/portal/projects/${A.projectId}/requests`,
      `/api/portal/projects/${A.projectId}/deliverables`,
      `/api/portal/projects/${A.projectId}/deliverables/${deliverableA}`,
      `/api/portal/projects/${A.projectId}/files/${fileA}/content`,
      `/api/portal/projects/${A.projectId}/deliveries`,
      `/api/portal/projects/${A.projectId}/deliveries/${deliveryA}/zip`,
      `/api/portal/projects/${A.projectId}/activity`,
      `/api/portal/projects/${B.projectId}/files/${fileA}/content`,
      `/api/portal/projects/${B.projectId}/deliverables/${deliverableA}`,
    ];
    for (const u of urls) expect((await clientB.get(u)).status, u).toBe(404);
    const writes: [string, unknown][] = [
      [`/api/portal/projects/${A.projectId}/versions/${versionA}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 1, confirm: true }],
      [`/api/portal/projects/${B.projectId}/versions/${versionA}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 1, confirm: true }],
      [`/api/portal/projects/${B.projectId}/versions/${versionA}/comments`, { body: 'x' }],
      [`/api/portal/projects/${B.projectId}/versions/${versionA}/change-request`, { body: 'x' }],
      [`/api/portal/projects/${A.projectId}/requests/${requestA}/submit`, {}],
      [`/api/portal/projects/${B.projectId}/uploads`, { name: 'a.png', size: 10, requestId: requestA }],
    ];
    for (const [u, b] of writes) expect((await clientB.post(u, b)).status, u).toBe(404);
  });

  it('顧客Aの招待トークンを顧客Bが使ってもメール確認で拒否', async () => {
    // 顧客Aの招待リンク（再発行後の最新）を取得
    const inv = await opA.post(`/api/app/projects/${A.projectId}/invites`, { days: 7 });
    const t = inv.body.url.split('#t=')[1];
    const r = await clientB.post('/api/invite/redeem', { token: t, email: B.email });
    expect(r.status).toBe(400);
    expect((await clientB.get(`/api/portal/projects/${A.projectId}`)).status).toBe(404);
    // 旧トークンは失効済み
    expect((await new Agent(app).post('/api/invite/redeem', { token: tokenA, email: A.email })).status).toBe(400);
  });

  it('顧客は運営管理APIにアクセスできない', async () => {
    for (const u of ['/api/app/projects', `/api/app/projects/${A.projectId}`, '/api/app/dashboard', '/api/auth/me', '/api/app/export', '/api/app/audit']) {
      expect((await clientA.get(u)).status, u).toBe(401);
    }
  });

  it('運営者Cookieでは顧客APIにアクセスできない（セッション分離）', async () => {
    expect((await opA.get(`/api/portal/projects/${A.projectId}`)).status).toBe(401);
  });

  it('顧客Aは内部ファイル（作業ファイル）を取得できない', async () => {
    expect((await clientA.get(`/api/portal/projects/${A.projectId}/files/${internalFileA}/content`)).status).toBe(404);
    expect((await clientA.get(`/api/portal/projects/${A.projectId}/files/${fileA}/content`)).status).toBe(200);
  });

  it('顧客向け応答に内部メモが含まれない', async () => {
    await opA.patch(`/api/app/projects/${A.projectId}/requests/${requestA}`, { internalMemo: 'INTERNAL-SECRET-MEMO' });
    const bodies = [
      await clientA.get(`/api/portal/projects/${A.projectId}`),
      await clientA.get(`/api/portal/projects/${A.projectId}/requests`),
      await clientA.get('/api/portal/projects'),
      await clientA.get('/api/portal/me'),
    ];
    for (const b of bodies) {
      const s = JSON.stringify(b.body);
      expect(s).not.toContain('社外秘メモ');
      expect(s).not.toContain('INTERNAL-SECRET-MEMO');
      expect(s).not.toContain('internalMemo');
    }
  });

  it('未認証ではファイルURLを知っていても取得不可', async () => {
    const anon = new Agent(app);
    expect((await anon.get(`/api/portal/projects/${A.projectId}/files/${fileA}/content`)).status).toBe(401);
    expect((await anon.get(`/api/app/projects/${A.projectId}/files/${fileA}/content`)).status).toBe(401);
  });

  it('アップロードIDを他者が使っても操作できない', async () => {
    const init = await clientA.post(`/api/portal/projects/${A.projectId}/uploads`, { name: 'b.png', size: 100, requestId: requestA });
    // requestA は未提出なので受付可
    expect(init.status).toBe(200);
    const id = init.body.uploadId;
    expect((await clientB.req('PUT', `/api/uploads/${id}/chunks/0`, Buffer.alloc(100))).status).toBe(404);
    expect((await opA.req('PUT', `/api/uploads/${id}/chunks/0`, Buffer.alloc(100))).status).toBe(404);
    expect((await clientB.post(`/api/uploads/${id}/complete`)).status).toBe(404);
    expect((await clientB.get(`/api/uploads/${id}`)).status).toBe(404);
  });
});

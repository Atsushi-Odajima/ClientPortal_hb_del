import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Agent, PNG, createClientAndProject, inviteClient, makeApp, newOperator, upload } from './helpers.js';
import { runOverdueCheck } from '../server/src/jobs.js';

let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  ({ app, dataDir } = await makeApp({ mail: { driver: 'dev-file', from: 'test <t@example.com>', smtpUrl: '', devDir: '' } }));
  app.ctx.cfg.mail.devDir = path.join(dataDir, 'mail-dev');
});
afterAll(async () => app.close());

describe('部分更新', () => {
  it('送っていない項目は変更されない（既定値で上書きしない）', async () => {
    const op = await newOperator(app);
    const { projectId, clientId } = await createClientAndProject(op);
    await op.patch(`/api/app/projects/${projectId}`, { clientGuidance: '案内', dueDate: '2030-01-01' });
    await op.patch(`/api/app/projects/${projectId}`, { name: '改名' });
    const d = await op.get(`/api/app/projects/${projectId}`);
    expect(d.body.project).toMatchObject({ name: '改名', description: 'desc', internalMemo: '社外秘メモ', clientGuidance: '案内', dueDate: '2030-01-01' });
    await op.patch(`/api/app/clients/${clientId}`, { phone: '03-0000-0000' });
    const c = await op.get(`/api/app/clients/${clientId}`);
    expect(c.body.client).toMatchObject({ contactName: '山田 太郎', phone: '03-0000-0000' });
    const rid = (await op.post(`/api/app/projects/${projectId}/requests`, { title: 'ロゴ', kind: 'choice', choices: ['A', 'B'], required: false, description: '説明' })).body.id;
    await op.patch(`/api/app/projects/${projectId}/requests/${rid}`, { title: 'ロゴ2' });
    const r = (await op.get(`/api/app/projects/${projectId}`)).body.requests[0];
    expect(r).toMatchObject({ title: 'ロゴ2', required: false, description: '説明', choices: ['A', 'B'] });
  });
});

describe('通知', () => {
  it('期限超過の通知は1日1回（重複防止）', async () => {
    const op = await newOperator(app);
    const { projectId, email } = await createClientAndProject(op);
    const { client } = await inviteClient(app, op, projectId, email);
    await op.post(`/api/app/projects/${projectId}/requests`, { title: '期限切れ資料', kind: 'text', dueDate: '2020-01-01' });
    runOverdueCheck(app.ctx);
    runOverdueCheck(app.ctx);
    const n = (await op.get('/api/app/notifications')).body.notifications.filter((x: { kind: string; title: string }) => x.kind === 'overdue' && x.title.includes('期限切れ資料'));
    expect(n).toHaveLength(1);
    const cn = (await client.get('/api/portal/notifications')).body.notifications.filter((x: { kind: string }) => x.kind === 'overdue');
    expect(cn).toHaveLength(1);
    const dash = await op.get('/api/app/dashboard');
    expect(dash.body.overdue.some((i: { title: string }) => i.title.includes('期限切れ資料'))).toBe(true);
  });

  it('メール通知: ポータルへ誘導・添付なし・重複なし・送信後は本文を消去', async () => {
    const op = await newOperator(app);
    const { projectId, email } = await createClientAndProject(op);
    const { client } = await inviteClient(app, op, projectId, email);
    const rid = (await op.post(`/api/app/projects/${projectId}/requests`, { title: '写真', kind: 'file' })).body.id;
    await upload(client, `/api/portal/projects/${projectId}/uploads`, 'a.png', PNG(), { requestId: rid });
    await client.post(`/api/portal/projects/${projectId}/requests/${rid}/submit`, {});
    const r = await app.ctx.mailer.flush(app.ctx.db);
    expect(r.sent).toBeGreaterThan(0);
    const files = fs.readdirSync(app.ctx.cfg.mail.devDir).map((f) => fs.readFileSync(path.join(app.ctx.cfg.mail.devDir, f), 'utf8'));
    const mail = files.find((f) => f.includes('資料が提出されました'));
    expect(mail).toBeTruthy();
    expect(mail).toContain('http://localhost:8787/app/projects/');
    expect(mail).toContain('ファイルはメールに添付されません');
    const sent = app.ctx.db.prepare(`SELECT body_text FROM mail_outbox WHERE status = 'sent'`).all() as { body_text: string }[];
    expect(sent.every((s) => s.body_text === '(sent)')).toBe(true);
    // 通知設定OFFでメールは積まれない
    await client.req('PUT', '/api/portal/notification-settings', { emailEnabled: false });
    const before = (app.ctx.db.prepare('SELECT COUNT(*) n FROM mail_outbox').get() as { n: number }).n;
    await op.post(`/api/app/projects/${projectId}/requests/${rid}/review`, { decision: 'accept' });
    const after = (app.ctx.db.prepare('SELECT COUNT(*) n FROM mail_outbox').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('マジックリンク: 登録有無を明かさず、1回限り・期限付き', async () => {
    const op = await newOperator(app);
    const { projectId, email } = await createClientAndProject(op);
    await inviteClient(app, op, projectId, email);
    const anon = new Agent(app);
    const unknown = await anon.post('/api/portal/magic-link', { email: 'nobody@example.com' });
    const known = await anon.post('/api/portal/magic-link', { email });
    expect(unknown.body).toEqual(known.body);
    await app.ctx.mailer.flush(app.ctx.db);
    const mails = fs.readdirSync(app.ctx.cfg.mail.devDir).map((f) => fs.readFileSync(path.join(app.ctx.cfg.mail.devDir, f), 'utf8'));
    const m = mails.find((x) => x.includes('ログイン用リンク') && x.includes(email));
    const token = /#m=([A-Za-z0-9_-]+)/.exec(m!)![1];
    const c = new Agent(app);
    expect((await c.post('/api/invite/redeem', { token })).status).toBe(200);
    expect((await c.get(`/api/portal/projects/${projectId}`)).status).toBe(200);
    expect((await new Agent(app).post('/api/invite/redeem', { token })).status).toBe(400);
    // 監査ログ・outbox に生トークンが残らない
    expect(JSON.stringify(app.ctx.db.prepare('SELECT * FROM audit_log').all())).not.toContain(token);
    expect(JSON.stringify(app.ctx.db.prepare('SELECT * FROM mail_outbox').all())).not.toContain(token);
  });
});

describe('エクスポート', () => {
  it('自分のデータとファイルのみを含む', async () => {
    const a = await newOperator(app);
    const b = await newOperator(app);
    const pa = await createClientAndProject(a);
    const pb = await createClientAndProject(b);
    await upload(a, `/api/app/projects/${pa.projectId}/uploads`, 'mine.png', PNG(), { target: { purpose: 'internal' } });
    await upload(b, `/api/app/projects/${pb.projectId}/uploads`, 'theirs.png', PNG(), { target: { purpose: 'internal' } });
    const r = await a.get('/api/app/export');
    expect(r.status).toBe(200);
    const z = unzipSync(new Uint8Array(r.raw));
    const data = JSON.parse(Buffer.from(z['data.json']).toString());
    expect(data.projects.map((p: { id: string }) => p.id)).toEqual([pa.projectId]);
    const names = Object.keys(z);
    expect(names.some((n) => n.endsWith('_mine.png'))).toBe(true);
    expect(names.some((n) => n.includes('theirs'))).toBe(false);
    expect(JSON.stringify(data)).not.toContain('password_hash');
  });
});

describe('サンプル', () => {
  it('仕様どおりのサンプル案件を作成し、まとめて削除できる', async () => {
    const op = await newOperator(app);
    const s = await op.post('/api/app/sample');
    expect(s.status).toBe(200);
    const d = (await op.get(`/api/app/projects/${s.body.projectId}`)).body;
    expect(d.client.companyName).toBe('Sample Creative株式会社');
    expect(d.project.name).toBe('秋キャンペーンSNS素材制作');
    expect(d.requests.map((r: { title: string }) => r.title)).toEqual(['ロゴデータ', '商品写真', '掲載文', 'ブランドカラー']);
    const a = d.deliverables.find((x: { title: string }) => x.title === '投稿画像A');
    expect(a.versions.map((v: { versionNumber: number; status: string }) => [v.versionNumber, v.status])).toEqual([
      [2, 'approved'],
      [1, 'superseded'],
    ]);
    expect(a.versions[1].changeRequests).toHaveLength(1);
    const b = d.deliverables.find((x: { title: string }) => x.title === '投稿画像B');
    expect(b.versions[0]).toMatchObject({ versionNumber: 1, status: 'approved' });
    expect(d.deliveries[0].items.map((i: { label: string }) => i.label)).toEqual(['投稿画像A v2', '投稿画像B v1']);
    const dd = (await op.get(`/api/app/projects/${s.body.projectId}/deliverables/${a.id}`)).body;
    expect(dd.comments[a.versions[1].id].filter((c: { pin: unknown }) => c.pin)).toHaveLength(2);
    // 顧客側体験
    const c = new Agent(app);
    expect((await c.post('/api/invite/redeem', { token: s.body.inviteUrl.split('#t=')[1], email: s.body.clientEmail })).status).toBe(200);
    expect((await op.post('/api/app/sample')).status).toBe(409);
    const del = await op.del('/api/app/sample');
    expect(del.body).toMatchObject({ deletedProjects: 1, deletedClients: 1 });
    expect((await op.get(`/api/app/projects/${s.body.projectId}`)).status).toBe(404);
  });
});

describe('レート制限（本番相当の設定）', () => {
  it('ログイン試行は1分あたり10回まで', async () => {
    const { app: prodLike } = await makeApp({ env: 'development' });
    const a = new Agent(prodLike);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await a.post('/api/auth/login', { email: 'x@example.com', password: 'wrong-password' })).status);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
    await prodLike.close();
  });
});

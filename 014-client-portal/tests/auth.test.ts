import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Agent, createClientAndProject, inviteClient, makeApp, newOperator } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  ({ app } = await makeApp({ allowSignup: false, setupToken: 'setup-secret-token' }));
});
afterAll(async () => app.close());

describe('運営者認証', () => {
  it('初回セットアップはトークン必須・1回のみ', async () => {
    const a = new Agent(app);
    const st = await a.get('/api/auth/state');
    expect(st.body).toMatchObject({ hasOperators: false, setupRequiresToken: true });
    const bad = await a.post('/api/auth/setup', { email: 'owner@example.com', name: 'Owner', password: 'correct horse battery', setupToken: 'wrong' });
    expect(bad.status).toBe(403);
    const ok = await a.post('/api/auth/setup', { email: 'owner@example.com', name: 'Owner', password: 'correct horse battery', setupToken: 'setup-secret-token' });
    expect(ok.status).toBe(200);
    const me = await a.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.operator.email).toBe('owner@example.com');
    const again = await new Agent(app).post('/api/auth/setup', { email: 'x@example.com', name: 'X', password: 'correct horse battery', setupToken: 'setup-secret-token' });
    expect(again.status).toBe(403);
  });

  it('新規登録が無効な場合は拒否', async () => {
    const r = await new Agent(app).post('/api/auth/signup', { email: 'y@example.com', name: 'Y', password: 'correct horse battery' });
    expect(r.status).toBe(403);
  });

  it('ログイン成功・失敗・ログアウト', async () => {
    const a = new Agent(app);
    expect((await a.post('/api/auth/login', { email: 'owner@example.com', password: 'wrong password!!' })).status).toBe(401);
    expect((await a.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong password!!' })).status).toBe(401);
    expect((await a.post('/api/auth/login', { email: 'OWNER@example.com', password: 'correct horse battery' })).status).toBe(200);
    const cookie = a.cookies.get('cp_op');
    expect(cookie).toBeTruthy();
    expect((await a.get('/api/app/projects')).status).toBe(200);
    await a.post('/api/auth/logout');
    expect((await a.get('/api/app/projects')).status).toBe(401);
    // ログアウト済みのセッショントークンを再利用しても無効
    const replay = new Agent(app);
    replay.cookies.set('cp_op', cookie!);
    expect((await replay.get('/api/app/projects')).status).toBe(401);
  });

  it('セッションCookieは HttpOnly / SameSite=Lax', async () => {
    const a = new Agent(app);
    const r = await a.post('/api/auth/login', { email: 'owner@example.com', password: 'correct horse battery' });
    const sc = String(r.headers['set-cookie']);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
  });
});

describe('CSRF・ヘッダ', () => {
  it('カスタムヘッダなしの状態変更は拒否', async () => {
    const a = new Agent(app, false);
    const r = await a.post('/api/auth/login', { email: 'owner@example.com', password: 'correct horse battery' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('csrf');
  });

  it('他オリジンからのリクエストは拒否', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', 'x-cp-csrf': '1', origin: 'https://evil.example' },
      payload: JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery' }),
    });
    expect(r.statusCode).toBe(403);
  });

  it('セキュリティヘッダ', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(String(r.headers['content-security-policy'])).toContain("object-src 'none'");
  });
});

describe('顧客招待', () => {
  it('招待→メール確認→アクセス、失効・期限切れ・再発行', async () => {
    const { app: app2 } = await makeApp();
    const op = await newOperator(app2);
    const { projectId, email } = await createClientAndProject(op);
    const inv = await op.post(`/api/app/projects/${projectId}/invites`, { days: 7 });
    expect(inv.status).toBe(200);
    expect(inv.body.url).toMatch(/\/invite#t=[A-Za-z0-9_-]{43}$/);
    const token = inv.body.url.split('#t=')[1];

    const c = new Agent(app2);
    const info = await c.post('/api/invite/inspect', { token });
    expect(info.body).toMatchObject({ valid: true, projectName: 'テスト案件' });
    expect(info.body.emailHint).not.toBe(email);
    // メール不一致
    const mismatch = await c.post('/api/invite/redeem', { token, email: 'other@example.com' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe('email_mismatch');
    const ok = await c.post('/api/invite/redeem', { token, email: email.toUpperCase() });
    expect(ok.status).toBe(200);
    expect((await c.get(`/api/portal/projects/${projectId}`)).status).toBe(200);

    // 再発行で旧リンクは失効
    const inv2 = await op.post(`/api/app/projects/${projectId}/invites`, { days: 7 });
    const old = await new Agent(app2).post('/api/invite/redeem', { token, email });
    expect(old.status).toBe(400);
    expect(old.body.error).toBe('invite_revoked');
    const token2 = inv2.body.url.split('#t=')[1];

    // 明示的な失効
    await op.post(`/api/app/projects/${projectId}/invites/${inv2.body.inviteId}/revoke`);
    expect((await new Agent(app2).post('/api/invite/redeem', { token: token2, email })).status).toBe(400);

    // 期限切れ
    const inv3 = await op.post(`/api/app/projects/${projectId}/invites`, { days: 1 });
    app2.ctx.db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), inv3.body.inviteId);
    const exp = await new Agent(app2).post('/api/invite/redeem', { token: inv3.body.url.split('#t=')[1], email });
    expect(exp.body.error).toBe('invite_expired');

    // 推測トークン
    expect((await new Agent(app2).post('/api/invite/inspect', { token: 'a'.repeat(43) })).body.valid).toBe(false);
    await app2.close();
  });

  it('メール確認5回失敗でリンクをロック', async () => {
    const { app: app2 } = await makeApp();
    const op = await newOperator(app2);
    const { projectId, email } = await createClientAndProject(op);
    const inv = await op.post(`/api/app/projects/${projectId}/invites`, { days: 7 });
    const token = inv.body.url.split('#t=')[1];
    const c = new Agent(app2);
    for (let i = 0; i < 4; i++) expect((await c.post('/api/invite/redeem', { token, email: `x${i}@example.com` })).body.error).toBe('email_mismatch');
    expect((await c.post('/api/invite/redeem', { token, email: 'x9@example.com' })).body.error).toBe('invite_locked');
    expect((await c.post('/api/invite/redeem', { token, email })).status).toBe(400);
    await app2.close();
  });

  it('アクセス停止・顧客アーカイブ・ポータル終了で即時にアクセス不可', async () => {
    const { app: app2 } = await makeApp();
    const op = await newOperator(app2);
    const { projectId, email, clientId } = await createClientAndProject(op);
    const { client } = await inviteClient(app2, op, projectId, email);
    expect((await client.get(`/api/portal/projects/${projectId}`)).status).toBe(200);

    const detail = await op.get(`/api/app/projects/${projectId}`);
    const accessId = detail.body.access[0].id;
    await op.post(`/api/app/projects/${projectId}/access/${accessId}`, { action: 'revoke' });
    expect((await client.get(`/api/portal/projects/${projectId}`)).status).toBe(404);
    await op.post(`/api/app/projects/${projectId}/access/${accessId}`, { action: 'restore' });
    expect((await client.get(`/api/portal/projects/${projectId}`)).status).toBe(200);

    await op.post(`/api/app/projects/${projectId}/portal`, { portalStatus: 'closed' });
    expect((await client.get(`/api/portal/projects/${projectId}`)).status).toBe(404);
    await op.post(`/api/app/projects/${projectId}/portal`, { portalStatus: 'published' });
    expect((await client.get(`/api/portal/projects/${projectId}`)).status).toBe(200);

    await op.post(`/api/app/clients/${clientId}/archive`, { archived: true });
    expect((await client.get(`/api/portal/projects/${projectId}`)).status).toBe(401);
    await app2.close();
  });
});

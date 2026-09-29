import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { Agent, PNG, PNG2, createClientAndProject, idem, inviteClient, makeApp, newOperator, submitVersion, tmpDir, upload } from './helpers.js';
import { createBackup, restoreBackup, verifyBackup } from '../server/src/backup.js';
import { loadConfig } from '../server/src/config.js';
import { verifyAuditChain } from '../server/src/audit.js';
import { buildApp } from '../server/src/app.js';

let app: FastifyInstance;
let dataDir: string;
let op: Agent;
let client: Agent;
let projectId: string;

beforeAll(async () => {
  ({ app, dataDir } = await makeApp());
  op = await newOperator(app);
  const r = await createClientAndProject(op);
  projectId = r.projectId;
  client = (await inviteClient(app, op, projectId, r.email)).client;
  // サンプル案件（A v1→ピン2件→修正依頼→v2→承認、B v1→承認、納品）も作成
  const s = await op.post('/api/app/sample');
  expect(s.status).toBe(200);
  const did = (await op.post(`/api/app/projects/${projectId}/deliverables`, { title: 'D' })).body.id;
  const v1 = (await submitVersion(op, projectId, did, PNG())).body.versionId;
  await client.post(`/api/portal/projects/${projectId}/versions/${v1}/comments`, { body: 'pin', pin: { x: 0.3, y: 0.4 } });
  const v2 = (await submitVersion(op, projectId, did, PNG2())).body.versionId;
  await client.post(`/api/portal/projects/${projectId}/versions/${v2}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 2, confirm: true });
});
afterAll(async () => app.close());

const snapshotQueries = {
  projects: 'SELECT id, name, status FROM projects ORDER BY id',
  versions: 'SELECT id, deliverable_id, version_number, file_id, status FROM deliverable_versions ORDER BY id',
  files: 'SELECT id, storage_key, sha256, size FROM files ORDER BY id',
  comments: 'SELECT id, version_id, body, pin_x, pin_y, pin_number FROM comments ORDER BY id',
  approvals: 'SELECT id, version_id, file_sha256, revoked_at FROM approvals ORDER BY id',
  deliveries: 'SELECT d.id, d.status, i.version_id, i.file_id FROM deliveries d JOIN delivery_items i ON i.delivery_id = d.id ORDER BY i.id',
  changeRequests: 'SELECT id, version_id, body FROM change_requests ORDER BY id',
};

function snapshot(db: Database.Database) {
  return Object.fromEntries(Object.entries(snapshotQueries).map(([k, q]) => [k, db.prepare(q).all()]));
}

describe('バックアップ・復元', () => {
  it('バックアップ → 空環境へ復元 → 案件/version/ファイル/コメント/承認ハッシュ/納品が一致', async () => {
    const out = tmpDir('cp-bk-');
    const { dir, manifest } = await createBackup(loadConfig({ dataDir }), out);
    expect(manifest).toMatchObject({ format: 'client-portal-backup', schemaVersion: 1, appVersion: '1.0.0' });
    expect(manifest.fileCount).toBeGreaterThan(5);
    expect(manifest.counts.approvals).toBeGreaterThan(0);
    expect(manifest.auditChain.ok).toBe(true);
    expect((await verifyBackup(dir)).ok).toBe(true);

    const before = snapshot(app.ctx.db);
    const emptyDir = path.join(tmpDir('cp-restore-'), 'data');
    const r = await restoreBackup(loadConfig({ dataDir: emptyDir }), dir);
    expect(r.previousDataMovedTo).toBeNull();
    const restored = await buildApp({ config: { dataDir: emptyDir, logLevel: 'silent', passwordScryptN: 1024, webDist: path.join(emptyDir, 'x') } });
    expect(snapshot(restored.ctx.db)).toEqual(before);
    // ファイル実体のバイト一致・承認ハッシュとの一致
    const rows = restored.ctx.db.prepare('SELECT f.storage_key, f.sha256, a.file_sha256 FROM approvals a JOIN files f ON f.id = a.file_id').all() as { storage_key: string; sha256: string; file_sha256: string }[];
    for (const row of rows) {
      expect(row.sha256).toBe(row.file_sha256);
      const a = fs.readFileSync(path.join(dataDir, 'objects', row.storage_key));
      const b = fs.readFileSync(path.join(emptyDir, 'objects', row.storage_key));
      expect(a.equals(b)).toBe(true);
    }
    expect(verifyAuditChain(restored.ctx.db).ok).toBe(true);
    // 復元後も運営者がログインして同じデータを閲覧できる
    const opEmail = (app.ctx.db.prepare('SELECT email FROM operators LIMIT 1').get() as { email: string }).email;
    const a2 = new Agent(restored);
    expect((await a2.post('/api/auth/login', { email: opEmail, password: 'correct horse battery' })).status).toBe(200);
    const pd = await a2.get(`/api/app/projects/${projectId}`);
    expect(pd.status).toBe(200);
    const img = await a2.get(pd.body.deliverables[0].versions[0].file.url);
    expect(img.raw.equals(PNG2())).toBe(true);
    await restored.close();
  });

  it('壊れたバックアップは検証で拒否し、現行データを変更しない', async () => {
    const out = tmpDir('cp-bk-');
    const { dir, manifest } = await createBackup(loadConfig({ dataDir }), out);
    // ファイル実体を改ざん
    const victim = path.join(dir, 'objects', ...manifest.files[0].key.split('/'));
    fs.writeFileSync(victim, Buffer.from('tampered'));
    const v = await verifyBackup(dir);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/サイズ不一致|ハッシュ/);
    // 既存データのある環境への復元が失敗しても現行データはそのまま
    const liveDir = path.join(tmpDir('cp-live-'), 'data');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'marker.txt'), 'current');
    await expect(restoreBackup(loadConfig({ dataDir: liveDir }), dir)).rejects.toThrow(/検証に失敗/);
    expect(fs.readFileSync(path.join(liveDir, 'marker.txt'), 'utf8')).toBe('current');
    expect(fs.readdirSync(path.dirname(liveDir)).filter((n) => n.includes('staging'))).toHaveLength(0);
  });

  it('manifest件数とDBの不一致を検出', async () => {
    const { dir } = await createBackup(loadConfig({ dataDir }), tmpDir('cp-bk-'));
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    m.counts.comments += 1;
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    const v = await verifyBackup(dir);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/件数不一致 comments/);
  });

  it('既存環境への復元は旧データを退避してから入れ替え', async () => {
    const { dir } = await createBackup(loadConfig({ dataDir }), tmpDir('cp-bk-'));
    const liveDir = path.join(tmpDir('cp-live-'), 'data');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'marker.txt'), 'old');
    const r = await restoreBackup(loadConfig({ dataDir: liveDir }), dir);
    expect(r.previousDataMovedTo).toBeTruthy();
    expect(fs.readFileSync(path.join(r.previousDataMovedTo!, 'marker.txt'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(liveDir, 'portal.sqlite'))).toBe(true);
  });
});

describe('監査ログ', () => {
  it('通常のUPDATE/DELETEはDBトリガーで拒否', () => {
    expect(() => app.ctx.db.prepare(`UPDATE audit_log SET summary = 'x'`).run()).toThrow(/append-only/);
    expect(() => app.ctx.db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });

  it('ハッシュチェーンで改ざんを検出', () => {
    const tmp = path.join(tmpDir('cp-audit-'), 'a.sqlite');
    return app.ctx.db.backup(tmp).then(() => {
      const db = new Database(tmp);
      expect(verifyAuditChain(db).ok).toBe(true);
      db.exec('DROP TRIGGER audit_log_no_update');
      db.prepare(`UPDATE audit_log SET summary = 'forged' WHERE seq = 3`).run();
      const v = verifyAuditChain(db);
      expect(v.ok).toBe(false);
      expect(v.brokenAt).toBe(3);
      db.close();
    });
  });

  it('監査ログに招待トークン・パスワードを保存しない', async () => {
    const inv = await op.post(`/api/app/projects/${projectId}/invites`, { days: 3 });
    const token = inv.body.url.split('#t=')[1];
    const all = JSON.stringify(app.ctx.db.prepare('SELECT * FROM audit_log').all());
    expect(all).not.toContain(token);
    expect(all).not.toContain('correct horse battery');
    const invites = JSON.stringify(app.ctx.db.prepare('SELECT * FROM invites').all());
    expect(invites).not.toContain(token);
  });

  it('主要イベントが記録される', async () => {
    const actions = new Set((app.ctx.db.prepare('SELECT DISTINCT action FROM audit_log').all() as { action: string }[]).map((r) => r.action));
    for (const a of [
      'invite.created',
      'invite.redeemed',
      'request.submitted',
      'request.accepted',
      'version.submitted',
      'version.new_version',
      'comment.created',
      'change_request.created',
      'approval.created',
      'delivery.published',
    ]) {
      expect(actions.has(a), a).toBe(true);
    }
  });
});

describe('ログに秘密情報を出さない', () => {
  it('リクエストログのURL・Cookie・招待トークンをマスク', async () => {
    const lines: string[] = [];
    const dir = tmpDir();
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logApp = await buildApp({
      config: { dataDir: dir, logLevel: 'info', passwordScryptN: 1024, allowSignup: true, webDist: path.join(dir, 'x'), publicUrl: 'http://localhost:8787' },
      logStream: stream,
    });
    const a = new Agent(logApp);
    await a.post('/api/auth/signup', { email: 'log@example.com', name: 'L', password: 'correct horse battery' });
    const { projectId: pid, email } = await createClientAndProject(a);
    const inv = await a.post(`/api/app/projects/${pid}/invites`, { days: 3 });
    const token = inv.body.url.split('#t=')[1];
    const c = new Agent(logApp);
    await c.post('/api/invite/redeem', { token, email });
    await c.get(`/api/portal/projects/${pid}?token=${token}`);
    const joined = lines.join('\n');
    expect(lines.length).toBeGreaterThan(5);
    expect(joined).toContain('[REDACTED]');
    expect(joined).not.toContain(token);
    expect(joined).not.toContain('cp_op=');
    expect(joined).not.toContain('correct horse battery');
    await logApp.close();
  });
});

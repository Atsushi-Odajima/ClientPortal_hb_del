import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
// @ts-expect-error s3rver has no types
import S3rver from 's3rver';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { unzipSync } from 'fflate';
import { PNG, PNG2, createClientAndProject, idem, inviteClient, makeApp, newOperator, submitVersion, tmpDir, upload } from './helpers.js';
import { loadConfig } from '../server/src/config.js';
import { createBackup, restoreBackup } from '../server/src/backup.js';

/** S3互換ドライバ（R2/S3想定）をローカルエミュレータ s3rver で検証 */
const PORT = 4599;
const s3cfg = {
  endpoint: `http://localhost:${PORT}`,
  region: 'us-east-1',
  bucket: 'cp-test',
  accessKeyId: 'S3RVER',
  secretAccessKey: 'S3RVER',
  forcePathStyle: true,
};
let server: { run: () => Promise<unknown>; close: () => Promise<void> };
let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  server = new S3rver({ port: PORT, address: 'localhost', silent: true, directory: tmpDir('s3rver-') });
  await server.run();
  const c = new S3Client({ region: 'us-east-1', endpoint: s3cfg.endpoint, forcePathStyle: true, credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' } });
  await c.send(new CreateBucketCommand({ Bucket: 'cp-test' }));
  ({ app, dataDir } = await makeApp({ storage: { driver: 's3', localDir: '', s3: s3cfg, signedUrlSeconds: 60 } }));
});
afterAll(async () => {
  await app?.close();
  await server?.close();
});

describe('S3互換ストレージ', () => {
  it('アップロード→プレビュー（アプリ経由）→ダウンロードは期限付き署名URLへリダイレクト', async () => {
    const op = await newOperator(app);
    const { projectId, email } = await createClientAndProject(op);
    const { client } = await inviteClient(app, op, projectId, email);
    const did = (await op.post(`/api/app/projects/${projectId}/deliverables`, { title: 'S3' })).body.id;
    const v = await submitVersion(op, projectId, did, PNG());
    expect(v.status).toBe(200);
    // ローカルディスクには保存されない
    expect(fs.existsSync(path.join(dataDir, 'objects'))).toBe(false);
    const f0 = v.body.file;
    const file = { url: f0.url.replace('/api/app/', '/api/portal/'), downloadUrl: f0.downloadUrl.replace('/api/app/', '/api/portal/') };
    const preview = await client.get(file.url);
    expect(preview.status).toBe(200);
    expect(preview.raw.equals(PNG())).toBe(true);
    const ranged = await client.get(file.url, { range: 'bytes=10-19' });
    expect(ranged.status).toBe(206);
    expect(ranged.raw.equals(PNG().subarray(10, 20))).toBe(true);
    const dl = await client.get(file.downloadUrl);
    expect(dl.status).toBe(302);
    const loc = String(dl.headers.location);
    expect(loc).toContain('X-Amz-Signature=');
    expect(loc).toContain('X-Amz-Expires=60');
    expect(loc).toContain('response-content-disposition=attachment');
    const fetched = Buffer.from(await (await fetch(loc)).arrayBuffer());
    expect(fetched.equals(PNG())).toBe(true);
    // 注: s3rver は署名の検証・期限切れを強制しないため、改ざん/期限切れURLの拒否は実サービス（R2/S3）側の仕様。実環境では未検証
    // 承認→納品ZIP（S3から読み出し）
    await client.post(`/api/portal/projects/${projectId}/versions/${v.body.versionId}/approve`, { idempotencyKey: idem(), expectedVersionNumber: 1, confirm: true });
    const d = await op.post(`/api/app/projects/${projectId}/deliveries`, { title: '納品', versionIds: [v.body.versionId] });
    await op.post(`/api/app/projects/${projectId}/deliveries/${d.body.id}/publish`, { confirm: true });
    const zip = await client.get(`/api/portal/projects/${projectId}/deliveries/${d.body.id}/zip`);
    const entries = unzipSync(new Uint8Array(zip.raw));
    expect(Buffer.from(entries['納品/S3_v1.png']).equals(PNG())).toBe(true);
  });

  it('案件削除でS3上の実体も削除', async () => {
    const op = await newOperator(app);
    const { projectId } = await createClientAndProject(op);
    const r = await upload(op, `/api/app/projects/${projectId}/uploads`, 'w.png', PNG2(), { target: { purpose: 'internal' } });
    const key = (app.ctx.db.prepare('SELECT storage_key FROM files WHERE id = ?').get(r.body.file.id) as { storage_key: string }).storage_key;
    expect(await app.ctx.storage.head(key)).not.toBeNull();
    await op.del(`/api/app/projects/${projectId}`, { confirmName: 'テスト案件' });
    expect(await app.ctx.storage.head(key)).toBeNull();
  });

  it('S3構成のバックアップ→復元', async () => {
    const cfg = loadConfig({ dataDir, storage: { driver: 's3', localDir: '', s3: s3cfg, signedUrlSeconds: 60 } });
    const { dir, manifest } = await createBackup(cfg, tmpDir('cp-s3bk-'));
    expect(manifest.storageDriver).toBe('s3');
    expect(manifest.fileCount).toBeGreaterThan(0);
    const target = path.join(tmpDir('cp-s3rs-'), 'data');
    const r = await restoreBackup({ ...cfg, dataDir: target, dbPath: path.join(target, 'portal.sqlite') }, dir);
    expect(r.manifest.fileCount).toBe(manifest.fileCount);
    expect(fs.existsSync(path.join(target, 'portal.sqlite'))).toBe(true);
  });
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Agent, PDF, PNG, createClientAndProject, inviteClient, makeApp, newOperator, upload } from './helpers.js';

let app: FastifyInstance;
let dataDir: string;
let op: Agent;
let client: Agent;
let projectId: string;
let requestId: string;

const clientUpload = (name: string, data: Buffer) => upload(client, `/api/portal/projects/${projectId}/uploads`, name, data, { requestId });
const opUpload = (name: string, data: Buffer) => upload(op, `/api/app/projects/${projectId}/uploads`, name, data, { target: { purpose: 'internal' } });

beforeAll(async () => {
  ({ app, dataDir } = await makeApp());
  op = await newOperator(app);
  const r = await createClientAndProject(op);
  projectId = r.projectId;
  client = (await inviteClient(app, op, projectId, r.email)).client;
  requestId = (await op.post(`/api/app/projects/${projectId}/requests`, { title: '素材', kind: 'file' })).body.id;
});
afterAll(async () => app.close());

const countFiles = () => (app.ctx.db.prepare('SELECT COUNT(*) n FROM files').get() as { n: number }).n;

describe('アップロード検証', () => {
  it('正常: 画像・PDF・日本語名・同名', async () => {
    const a = await clientUpload('ロゴ データ（最新）.png', PNG());
    expect(a.status).toBe(200);
    expect(a.body.file).toMatchObject({ name: 'ロゴ データ（最新）.png', mime: 'image/png', previewKind: 'image', width: 800, height: 800 });
    expect(a.body.file.sha256).toBe(crypto.createHash('sha256').update(PNG()).digest('hex'));
    const b = await clientUpload('ロゴ データ（最新）.png', PNG());
    expect(b.status).toBe(200);
    expect(b.body.file.id).not.toBe(a.body.file.id);
    const pdf = await clientUpload('資料.pdf', PDF());
    expect(pdf.body.file).toMatchObject({ mime: 'application/pdf', previewKind: 'pdf' });
  });

  it('0バイトは拒否', async () => {
    const r = await clientUpload('empty.png', Buffer.alloc(0));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('empty_file');
  });

  it('上限超過は開始時に拒否', async () => {
    const r = await client.post(`/api/portal/projects/${projectId}/uploads`, { name: 'big.mp4', size: 6 * 1024 * 1024, requestId });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('too_large');
  });

  it('危険な拡張子は拒否', async () => {
    for (const n of ['setup.exe', 'run.bat', 'x.js', 'page.html', 'a.HTM', 'script.ps1', 'app.apk']) {
      const r = await client.post(`/api/portal/projects/${projectId}/uploads`, { name: n, size: 100, requestId });
      expect(r.status, n).toBe(400);
      expect(r.body.error, n).toBe('blocked_type');
    }
  });

  it('偽装拡張子（実体が実行形式）は拒否', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2000, 1)]);
    const r = await clientUpload('photo.jpg', exe);
    expect(r.status).toBe(400);
    expect(['blocked_type', 'type_mismatch']).toContain(r.body.error);
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(2000, 2)]);
    const r2 = await clientUpload('data.bin', elf);
    expect(r2.status).toBe(400);
    expect(r2.body.error).toBe('blocked_type');
    const sh = Buffer.from('#!/bin/sh\nrm -rf /\n');
    expect((await clientUpload('readme.txt', sh)).body.error).toBe('blocked_type');
  });

  it('拡張子とMIME（実体）の不一致は拒否', async () => {
    const r = await clientUpload('image.png', Buffer.from('this is plain text, not a png'));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('type_mismatch');
    const r2 = await clientUpload('doc.pdf', PNG());
    expect(r2.body.error).toBe('type_mismatch');
  });

  it('長いファイル名・制御文字は安全に扱う', async () => {
    const long = `${'あ'.repeat(260)}.png`;
    const r = await client.post(`/api/portal/projects/${projectId}/uploads`, { name: long, size: 100, requestId });
    expect(r.status).toBe(400); // 255文字超
    const ok = await clientUpload(`${'長い名前'.repeat(40)}.png`, PNG());
    expect(ok.status).toBe(200);
    const dl = await client.get(`/api/portal/projects/${projectId}/files/${ok.body.file.id}/content?dl=1`);
    expect(dl.status).toBe(200);
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    const evil = await clientUpload('../../etc/passwd\r\n.txt', Buffer.from('hello'));
    expect(evil.status).toBe(200);
    const row = app.ctx.db.prepare('SELECT storage_key FROM files WHERE id = ?').get(evil.body.file.id) as { storage_key: string };
    expect(row.storage_key).toMatch(/^p\/prj_[A-Za-z0-9]+\/fil_[A-Za-z0-9]+$/);
    const d2 = await client.get(`/api/portal/projects/${projectId}/files/${evil.body.file.id}/content?dl=1`);
    expect(String(d2.headers['content-disposition'])).not.toMatch(/[\r\n]/);
  });

  it('SVG/テキストはプレビューせず必ずダウンロード扱い（同一オリジンで実行させない）', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r = await clientUpload('logo.svg', svg);
    expect(r.status).toBe(200);
    expect(r.body.file.previewKind).toBe('none');
    const get = await client.get(`/api/portal/projects/${projectId}/files/${r.body.file.id}/content`);
    expect(String(get.headers['content-disposition'])).toMatch(/^attachment/);
    expect(get.headers['content-type']).toBe('application/octet-stream');
    expect(String(get.headers['content-security-policy'])).toContain('sandbox');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
  });

  it('画像プレビューは inline + sandbox CSP + nosniff', async () => {
    const r = await clientUpload('p.png', PNG());
    const get = await client.get(`/api/portal/projects/${projectId}/files/${r.body.file.id}/content`);
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(String(get.headers['content-disposition'])).toMatch(/^inline/);
    expect(String(get.headers['content-security-policy'])).toContain('sandbox');
    expect(get.raw.equals(PNG())).toBe(true);
  });

  it('Rangeリクエスト（iPhoneの動画再生に必要）', async () => {
    const r = await clientUpload('r.png', PNG());
    const get = await client.get(`/api/portal/projects/${projectId}/files/${r.body.file.id}/content`, { range: 'bytes=0-99' });
    expect(get.status).toBe(206);
    expect(get.headers['content-range']).toBe(`bytes 0-99/${PNG().length}`);
    expect(get.raw.length).toBe(100);
    const bad = await client.get(`/api/portal/projects/${projectId}/files/${r.body.file.id}/content`, { range: 'bytes=99999999-' });
    expect(bad.status).toBe(416);
  });
});

describe('分割アップロード・失敗と再試行', () => {
  it('複数チャンク・途中失敗→同じチャンクを再送→完了', async () => {
    const data = crypto.randomBytes(700 * 1024); // 256KB x 3
    const file = Buffer.concat([PNG().subarray(0, 64), data]); // PNG署名で始まる
    const init = await client.post(`/api/portal/projects/${projectId}/uploads`, { name: 'large.png', size: file.length, requestId });
    const { uploadId, chunkSize, chunkCount } = init.body;
    expect(chunkCount).toBe(3);
    await client.req('PUT', `/api/uploads/${uploadId}/chunks/0`, file.subarray(0, chunkSize));
    // 途中で切れた（サイズ不足）チャンク
    const broken = await client.req('PUT', `/api/uploads/${uploadId}/chunks/1`, file.subarray(chunkSize, chunkSize + 1000));
    expect(broken.status).toBe(400);
    expect(broken.body.error).toBe('chunk_size');
    // 全部そろう前の完了要求
    const early = await client.post(`/api/uploads/${uploadId}/complete`);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('incomplete');
    // 状態確認（再開用）
    const st = await client.get(`/api/uploads/${uploadId}`);
    expect(st.body.received).toEqual([0]);
    // 再試行
    expect((await client.req('PUT', `/api/uploads/${uploadId}/chunks/1`, file.subarray(chunkSize, chunkSize * 2))).status).toBe(200);
    expect((await client.req('PUT', `/api/uploads/${uploadId}/chunks/2`, file.subarray(chunkSize * 2))).status).toBe(200);
    // 同じチャンクの再送は冪等
    expect((await client.req('PUT', `/api/uploads/${uploadId}/chunks/2`, file.subarray(chunkSize * 2))).status).toBe(200);
    const done = await client.post(`/api/uploads/${uploadId}/complete`);
    // PNG署名だけの壊れたPNGでも file-type は png と判定する
    expect(done.status).toBe(200);
    expect(done.body.file.size).toBe(file.length);
    // 完了の再送は同じ結果
    const again = await client.post(`/api/uploads/${uploadId}/complete`);
    expect(again.body.file.id).toBe(done.body.file.id);
    expect(again.body.duplicate).toBe(true);
    const content = await client.get(`/api/portal/projects/${projectId}/files/${done.body.file.id}/content?dl=1`);
    expect(content.raw.equals(file)).toBe(true);
  });

  it('宣言より大きいチャンクは拒否', async () => {
    const init = await client.post(`/api/portal/projects/${projectId}/uploads`, { name: 's.png', size: 100, requestId });
    const r = await client.req('PUT', `/api/uploads/${init.body.uploadId}/chunks/0`, Buffer.alloc(5000));
    expect(r.status).toBe(400);
  });

  it('ストレージ保存に失敗したらDBレコードを残さない・再試行で成功', async () => {
    const before = countFiles();
    const orig = app.ctx.storage.putFile.bind(app.ctx.storage);
    let fail = true;
    app.ctx.storage.putFile = async (...args) => {
      if (fail) throw new Error('simulated storage outage');
      return orig(...args);
    };
    const init = await client.post(`/api/portal/projects/${projectId}/uploads`, { name: 'net.png', size: PNG().length, requestId });
    const { uploadId, chunkSize, chunkCount } = init.body;
    for (let i = 0; i < chunkCount; i++) await client.req('PUT', `/api/uploads/${uploadId}/chunks/${i}`, PNG().subarray(i * chunkSize, (i + 1) * chunkSize));
    const r = await client.post(`/api/uploads/${uploadId}/complete`);
    expect(r.status).toBe(500);
    expect(countFiles()).toBe(before);
    fail = false;
    const retry = await client.post(`/api/uploads/${uploadId}/complete`);
    expect(retry.status).toBe(200);
    expect(countFiles()).toBe(before + 1);
    app.ctx.storage.putFile = orig;
  });

  it('DB記録に失敗したらストレージ実体も削除', async () => {
    const objectsBefore = await listObjects();
    const init = await op.post(`/api/app/projects/${projectId}/uploads`, { name: 'x.png', size: PNG().length, target: { purpose: 'internal' } });
    const { uploadId, chunkSize, chunkCount } = init.body;
    for (let i = 0; i < chunkCount; i++) await op.req('PUT', `/api/uploads/${uploadId}/chunks/${i}`, PNG().subarray(i * chunkSize, (i + 1) * chunkSize));
    const db = app.ctx.db;
    db.exec(`CREATE TEMP TRIGGER fail_insert BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'simulated db failure'); END;`);
    const r = await op.post(`/api/uploads/${uploadId}/complete`);
    db.exec('DROP TRIGGER fail_insert');
    expect(r.status).toBe(500);
    expect(await listObjects()).toEqual(objectsBefore);
  });

  it('提出済みの資料リクエストには追加アップロード不可', async () => {
    const rid = (await op.post(`/api/app/projects/${projectId}/requests`, { title: '写真', kind: 'file' })).body.id;
    await upload(client, `/api/portal/projects/${projectId}/uploads`, 'a.png', PNG(), { requestId: rid });
    expect((await client.post(`/api/portal/projects/${projectId}/requests/${rid}/submit`, {})).status).toBe(200);
    const r = await client.post(`/api/portal/projects/${projectId}/uploads`, { name: 'b.png', size: 100, requestId: rid });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('request_locked');
  });
});

async function listObjects(): Promise<string[]> {
  const out: string[] = [];
  for await (const k of app.ctx.storage.list()) out.push(k);
  return out.sort();
}

describe('一時ファイル', () => {
  it('完了後は一時ディレクトリが削除される', async () => {
    const r = await opUpload('t.png', PNG());
    expect(r.status).toBe(200);
    const tmp = path.join(dataDir, 'tmp', 'uploads');
    const left = fs.existsSync(tmp) ? fs.readdirSync(tmp) : [];
    const rows = app.ctx.db.prepare(`SELECT id FROM uploads WHERE status = 'completed'`).all() as { id: string }[];
    for (const row of rows) expect(left).not.toContain(row.id);
  });
});

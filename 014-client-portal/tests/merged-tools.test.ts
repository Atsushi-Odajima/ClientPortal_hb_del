/**
 * 統合した2機能のテスト
 *  - Client Portal 修正指示（元: 画像 修正指示メーカー）: ピンの指示タイプ・修正指示書（JSON/TXT）・修正依頼との連携・認可
 *  - Client Portal 写真セレクト（元: 写真セレクト一覧メーカー）: 番号付け・番号入力の読み取り・CSV・公開状態・認可
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Agent, PDF, PNG, createClientAndProject, inviteClient, makeApp, makePng, newOperator, submitVersion, tmpDir, upload } from './helpers.js';
import { buildCsv, buildSelectionText, checkSelection, csvField, formatNumber, naturalCompare } from '../shared/photoSelect.js';
import { applyPreset, buildInstructionText, circled, normalizePinType } from '../shared/correctionSheet.js';
import { migrate } from '../server/src/db.js';
import { createBackup, verifyBackup } from '../server/src/backup.js';
import { loadConfig } from '../server/src/config.js';

// ------------------------------------------------------------------
// 共有ロジック（元ツールの単体テストを移植）
// ------------------------------------------------------------------
describe('写真セレクト: 番号・読み取り・CSV（元ツールの規則）', () => {
  it('formatNumber: 3桁ゼロ埋め、100枚超・1000以上も正常', () => {
    expect([1, 12, 100, 250, 1000].map(formatNumber)).toEqual(['001', '012', '100', '250', '1000']);
  });

  it('naturalCompare: IMG_2 → IMG_10 の数字順', () => {
    expect(['IMG_10.jpg', 'IMG_2.jpg', 'img_1.jpg', 'IMG_100.jpg'].sort(naturalCompare)).toEqual(['img_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg', 'IMG_100.jpg']);
  });

  it('buildCsv: BOM・ヘッダ・番号・CRLF・引用・数式対策', () => {
    const csv = buildCsv(['IMG_5832.jpg', 'IMG_5835.jpg', 'a,b.jpg', 'say "hi".png', '=cmd.jpg']);
    expect(csv.startsWith('﻿番号,元ファイル名\r\n')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines.slice(1)).toEqual(['001,IMG_5832.jpg', '002,IMG_5835.jpg', '003,"a,b.jpg"', '004,"say ""hi"".png"', "005,'=cmd.jpg", '']);
    // 番号を指定した場合（選択結果の書き出し）
    expect(buildCsv(['x.jpg', 'y.jpg'], [7, 12]).slice(1).split('\r\n').slice(1, 3)).toEqual(['007,x.jpg', '012,y.jpg']);
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('@a')).toBe("'@a");
  });

  it('buildCsv: 120件でも番号が連番', () => {
    const names = Array.from({ length: 120 }, (_, i) => `P${i}.jpg`);
    const lines = buildCsv(names).slice(1).trim().split('\r\n').slice(1);
    expect(lines.length).toBe(120);
    lines.forEach((l, i) => expect(l).toBe(`${formatNumber(i + 1)},P${i}.jpg`));
  });

  it('checkSelection: 001,007,012 から正しい元名', () => {
    const names = Array.from({ length: 15 }, (_, i) => `IMG_${i + 1}.jpg`);
    const r = checkSelection('001, 007、012', names);
    expect(r.results.map((x) => [x.label, x.name])).toEqual([
      ['001', 'IMG_1.jpg'],
      ['007', 'IMG_7.jpg'],
      ['012', 'IMG_12.jpg'],
    ]);
    expect(r.invalid).toEqual([]);
  });

  it('checkSelection: 区切り（カンマ・全角カンマ・読点・空白・全角空白・改行・タブ）', () => {
    const names = Array.from({ length: 20 }, (_, i) => `n${i + 1}`);
    const r = checkSelection('001，002､003\n004\t005　006  007\r\n008', names);
    expect(r.results.map((x) => x.label)).toEqual(['001', '002', '003', '004', '005', '006', '007', '008']);
  });

  it('checkSelection: 存在しない番号は補正せず該当なし／0省略は 007 として照合', () => {
    const r = checkSelection('000 003 004 999', ['a.jpg', 'b.jpg', 'c.jpg']);
    expect(r.results.map((x) => [x.label, x.found, x.name])).toEqual([
      ['000', false, null],
      ['003', true, 'c.jpg'],
      ['004', false, null],
      ['999', false, null],
    ]);
    const r2 = checkSelection('7', Array.from({ length: 10 }, (_, i) => `x${i + 1}`));
    expect(r2.results[0]).toMatchObject({ input: '7', label: '007', name: 'x7', found: true });
  });

  it('checkSelection: 数字以外は読めない扱い・重複を知らせる・全角数字・空入力', () => {
    const r = checkSelection('00l, 7番, abc, 002', ['a', 'b', 'c']);
    expect(r.invalid).toEqual(['00l', '7番', 'abc']);
    expect(r.results.map((x) => x.label)).toEqual(['002']);
    const d = checkSelection('001 001 7 007 007', Array.from({ length: 10 }, (_, i) => 'x' + i));
    expect(d.results.map((x) => x.label)).toEqual(['001', '007']);
    expect(d.duplicates).toEqual([
      { label: '001', count: 2 },
      { label: '007', count: 3 },
    ]);
    expect(checkSelection('００３', ['a', 'b', 'c']).results[0].name).toBe('c');
    expect(checkSelection('  、, ', ['a']).empty).toBe(true);
  });

  it('buildSelectionText: 「001 → 元ファイル名」形式', () => {
    const t = buildSelectionText({ title: 'T', clientName: '山田', note: 'よろしく' }, [{ number: 7, name: 'IMG_7.jpg' }]);
    expect(t).toContain('007 → IMG_7.jpg');
    expect(t).toContain('選択枚数：1枚');
    expect(t).toContain('【コメント】\nよろしく');
    expect(buildSelectionText({}, [], '\r\n')).toContain('（選択なし）');
  });
});

describe('修正指示: 指示タイプ・修正指示テキスト（元ツールの規則）', () => {
  it('circled: ①〜⑳、21以降は (21)', () => {
    expect([1, 2, 20, 21, 100].map(circled)).toEqual(['①', '②', '⑳', '(21)', '(100)']);
  });

  it('applyPreset: 「〇〇を」+定型文、「ください」で終わる文には句点を補う', () => {
    expect(applyPreset('右下のロゴを', '削除してください')).toBe('右下のロゴを削除してください。');
    expect(applyPreset('', '色を変更してください')).toBe('色を変更してください。');
    expect(applyPreset('大きくしてください', '右へ移動してください')).toBe('大きくしてください。右へ移動してください。');
  });

  it('normalizePinType: 不明・未設定は「変更」', () => {
    expect([null, undefined, 'x', 'keep', 'delete'].map((t) => normalizePinType(t as string))).toEqual(['change', 'change', 'change', 'keep', 'delete']);
  });

  it('buildInstructionText: 【修正指示】と【変更しない箇所】を分け、番号順・備考・CRLF', () => {
    const t = buildInstructionText({ projectName: '春の新作', imageName: 'バナー v1', date: '2026-10-07', note: '全体的に明るく' }, [
      { number: 3, type: 'keep', text: 'ロゴはそのまま' },
      { number: 1, type: 'delete', text: '右下の文字を削除してください' },
      { number: 2, type: 'change', text: '' },
      { number: 4, type: 'keep', text: '' },
    ]);
    const lines = t.split('\n');
    expect(lines.slice(0, 3)).toEqual(['案件名：春の新作', '画像名：バナー v1', '作成日：2026/10/07']);
    expect(t).toContain('※ 青い四角の番号は「変更しない箇所」です。');
    const fix = t.indexOf('【修正指示】');
    const keep = t.indexOf('【変更しない箇所】');
    const note = t.indexOf('【備考】');
    expect(fix).toBeGreaterThan(0);
    expect(keep).toBeGreaterThan(fix);
    expect(note).toBeGreaterThan(keep);
    expect(t.indexOf('① [削除]')).toBeLessThan(t.indexOf('② [変更]'));
    expect(t).toContain('② [変更]\n（内容未入力）');
    expect(t).toContain('③\nロゴはそのまま');
    expect(t).toContain('④\n（内容未入力：この箇所は変更しないでください）');
    expect(t.endsWith('全体的に明るく')).toBe(true);
    const crlf = buildInstructionText({}, [{ number: 1, type: 'change', text: 'a\nb' }], '\r\n');
    expect(crlf).toContain('a\r\nb');
    expect(crlf.replace(/\r\n/g, '')).not.toContain('\n');
    expect(buildInstructionText({}, [])).toContain('【修正指示】\n\n（なし）');
    expect(buildInstructionText({}, [])).not.toContain('【変更しない箇所】');
  });
});

// ------------------------------------------------------------------
// スキーマ移行（v1 → v2）
// ------------------------------------------------------------------
describe('スキーマ移行 v1 → v2', () => {
  it('既存データ（files・ピンコメント）を保ったまま files を作り直し、selection_photo を受け付ける', () => {
    const dir = tmpDir('cp-mig-');
    const db = new Database(path.join(dir, 'x.sqlite'));
    db.pragma('foreign_keys = ON');
    // v1 だけを適用した状態を作る
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    db.exec(fs.readFileSync(path.resolve(__dirname, '../server/migrations/001_init.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(new Date().toISOString());
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO operators (id, email, name, password_hash, created_at, updated_at) VALUES ('op_1','a@example.com','A','x',?,?)`).run(now, now);
    db.prepare(`INSERT INTO clients (id, owner_id, company_name, email, created_at, updated_at) VALUES ('cl_1','op_1','C','c@example.com',?,?)`).run(now, now);
    db.prepare(`INSERT INTO projects (id, owner_id, client_id, name, created_at, updated_at) VALUES ('prj_1','op_1','cl_1','P',?,?)`).run(now, now);
    db.prepare(`INSERT INTO deliverables (id, project_id, title, created_at, updated_at) VALUES ('dlv_1','prj_1','D',?,?)`).run(now, now);
    db.prepare(
      `INSERT INTO files (id, project_id, owner_id, uploader_type, uploader_id, original_name, storage_key, mime, size, sha256, purpose, preview_kind, created_at)
       VALUES ('fil_1','prj_1','op_1','operator','op_1','a.png','p/prj_1/fil_1','image/png',10,'abc','deliverable_version','image',?)`,
    ).run(now);
    db.prepare(`INSERT INTO deliverable_versions (id, deliverable_id, project_id, version_number, file_id, submitted_by, submitted_at) VALUES ('ver_1','dlv_1','prj_1',1,'fil_1','op_1',?)`).run(now);
    db.prepare(
      `INSERT INTO comments (id, project_id, deliverable_id, version_id, author_type, author_id, author_name, body, pin_x, pin_y, pin_number, created_at)
       VALUES ('cmt_1','prj_1','dlv_1','ver_1','client','cl_1','C','直して',0.5,0.5,1,?)`,
    ).run(now);
    migrate(db);
    expect((db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number }).v).toBe(2);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT id, sha256, purpose FROM files').all()).toEqual([{ id: 'fil_1', sha256: 'abc', purpose: 'deliverable_version' }]);
    expect((db.prepare(`SELECT pin_type FROM comments WHERE id='cmt_1'`).get() as { pin_type: string }).pin_type).toBe('change');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // 版のファイル参照は維持（files を消すと外部キー違反）
    expect(() => db.prepare(`DELETE FROM files WHERE id='fil_1'`).run()).toThrow();
    // 不変トリガーも再作成されている
    expect(() => db.prepare(`UPDATE files SET sha256='zzz' WHERE id='fil_1'`).run()).toThrow(/immutable/);
    db.prepare(
      `INSERT INTO files (id, project_id, owner_id, uploader_type, uploader_id, original_name, storage_key, mime, size, sha256, purpose, preview_kind, created_at)
       VALUES ('fil_2','prj_1','op_1','operator','op_1','b.png','p/prj_1/fil_2','image/png',10,'def','selection_photo','image',?)`,
    ).run(now);
    expect(() => db.prepare(`UPDATE comments SET pin_type='bogus' WHERE id='cmt_1'`).run()).toThrow();
    db.close();
  });
});

// ------------------------------------------------------------------
// API（運営者・顧客・認可）
// ------------------------------------------------------------------
let app: FastifyInstance;
let dataDir: string;
let op: Agent;
let opB: Agent;
let client: Agent;
let otherClient: Agent; // 同じ運営者の別案件の顧客
let clientB: Agent; // 別の運営者の顧客
let projectId: string;
let otherProjectId: string;
let projectB: string;

beforeAll(async () => {
  ({ app, dataDir } = await makeApp());
  op = await newOperator(app);
  opB = await newOperator(app, 'OpB');
  const a = await createClientAndProject(op);
  projectId = a.projectId;
  client = (await inviteClient(app, op, projectId, a.email)).client;
  const o = await createClientAndProject(op);
  otherProjectId = o.projectId;
  otherClient = (await inviteClient(app, op, otherProjectId, o.email)).client;
  const b = await createClientAndProject(opB);
  projectB = b.projectId;
  clientB = (await inviteClient(app, opB, projectB, b.email)).client;
});
afterAll(async () => app.close());

describe('Client Portal 修正指示（API）', () => {
  let did: string;
  let v1: string;
  const pins: Record<string, string> = {};

  it('ピンに指示タイプを付けて置ける（顧客・運営者）。画像以外・不正タイプは拒否', async () => {
    did = (await op.post(`/api/app/projects/${projectId}/deliverables`, { title: 'バナー' })).body.id;
    v1 = (await submitVersion(op, projectId, did, PNG(), 'banner.png')).body.versionId;
    const P = `/api/portal/projects/${projectId}/versions/${v1}/comments`;
    let r = await client.post(P, { body: '右下の文字を削除してください', pin: { x: 0.8, y: 0.9 }, pinType: 'delete' });
    expect(r.status).toBe(200);
    pins.del = r.body.id;
    r = await client.post(P, { body: 'ロゴはそのまま', pin: { x: 0.1, y: 0.1 }, pinType: 'keep' });
    pins.keep = r.body.id;
    r = await client.post(P, { body: '色を明るく', pin: { x: 0.5, y: 0.5 } }); // 省略時は「変更」
    pins.change = r.body.id;
    r = await op.post(`/api/app/projects/${projectId}/versions/${v1}/comments`, { body: '見出しを追加します', pin: { x: 0.5, y: 0.2 }, pinType: 'add' });
    expect(r.status).toBe(200);
    pins.opAdd = r.body.id;
    expect((await client.post(P, { body: 'x', pin: { x: 0.2, y: 0.2 }, pinType: 'bogus' })).status).toBe(400);
    // 画像以外（PDF）の版にはピン不可
    const did2 = (await op.post(`/api/app/projects/${projectId}/deliverables`, { title: '資料PDF' })).body.id;
    const vp = (await submitVersion(op, projectId, did2, PDF(), 'doc.pdf')).body.versionId;
    expect((await client.post(`/api/portal/projects/${projectId}/versions/${vp}/comments`, { body: 'x', pin: { x: 0.2, y: 0.2 }, pinType: 'keep' })).status).toBe(400);
    const d = await op.get(`/api/app/projects/${projectId}/deliverables/${did}`);
    const list = d.body.comments[v1] as { id: string; pin: { number: number; type: string; typeLabel: string } }[];
    expect(list.find((c) => c.id === pins.keep)!.pin).toMatchObject({ number: 2, type: 'keep', typeLabel: '変更しない' });
    expect(list.find((c) => c.id === pins.change)!.pin.type).toBe('change');
  });

  it('指示タイプの変更は本人のみ', async () => {
    expect((await client.patch(`/api/portal/projects/${projectId}/comments/${pins.change}`, { body: '色を明るく（全体）', pinType: 'other' })).status).toBe(200);
    expect((await op.patch(`/api/app/projects/${projectId}/comments/${pins.change}`, { body: 'x', pinType: 'keep' })).status).toBe(403);
    const d = await client.get(`/api/portal/projects/${projectId}/deliverables/${did}`);
    expect(d.body.comments[v1].find((c: { id: string }) => c.id === pins.change).pin.type).toBe('other');
  });

  it('修正指示書: JSON（運営者・顧客）と TXT（BOM・CRLF・【変更しない箇所】を別枠）', async () => {
    const j = await client.get(`/api/portal/projects/${projectId}/versions/${v1}/instructions`);
    expect(j.status).toBe(200);
    expect(j.body.pins.map((p: { number: number; type: string }) => [p.number, p.type])).toEqual([
      [1, 'delete'],
      [2, 'keep'],
      [3, 'other'],
      [4, 'add'],
    ]);
    expect(j.body.file.url).toMatch(/^\/api\/portal\//);
    expect(j.body.text).toContain('① [削除]\n右下の文字を削除してください');
    expect(j.body.text).toContain('【変更しない箇所】\n\n②\nロゴはそのまま');
    const o = await op.get(`/api/app/projects/${projectId}/versions/${v1}/instructions`);
    expect(o.body.file.url).toMatch(/^\/api\/app\//);
    const t = await op.get(`/api/app/projects/${projectId}/versions/${v1}/instructions?format=txt`);
    expect(t.status).toBe(200);
    expect(String(t.headers['content-type'])).toMatch(/text\/plain/);
    expect(String(t.headers['content-disposition'])).toMatch(/attachment/);
    expect(t.raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const body = t.raw.toString('utf8');
    expect(body).toContain('\r\n');
    expect(body.replace(/\r\n/g, '')).not.toContain('\n');
    expect(body).toContain('案件名：テスト案件');
  });

  it('修正依頼と連携: 依頼時点の未解決ピンだけの指示書・件数表示、解決済みは既定で除外', async () => {
    // 運営者のピン（④）を解決済みにしてから顧客が修正依頼
    expect((await op.post(`/api/app/projects/${projectId}/comments/${pins.opAdd}/resolve`, { resolved: true })).status).toBe(200);
    const cr = await client.post(`/api/portal/projects/${projectId}/versions/${v1}/change-request`, { body: '上記ピンの通り修正をお願いします' });
    expect(cr.status).toBe(200);
    const d = await client.get(`/api/portal/projects/${projectId}/deliverables/${did}`);
    const v = d.body.deliverable.versions.find((x: { id: string }) => x.id === v1);
    expect(v.changeRequests[0]).toMatchObject({ id: cr.body.id, pinCount: 3 });
    const s = await op.get(`/api/app/projects/${projectId}/versions/${v1}/instructions?changeRequestId=${cr.body.id}`);
    expect(s.body.pins.map((p: { number: number }) => p.number)).toEqual([1, 2, 3]);
    expect(s.body.changeRequest.body).toBe('上記ピンの通り修正をお願いします');
    expect(s.body.text).toContain('【備考】');
    // 依頼後に新しいピンを足しても、依頼時点の指示書は変わらない
    await client.post(`/api/portal/projects/${projectId}/versions/${v1}/comments`, { body: '追加', pin: { x: 0.3, y: 0.3 } });
    const s2 = await op.get(`/api/app/projects/${projectId}/versions/${v1}/instructions?changeRequestId=${cr.body.id}`);
    expect(s2.body.pins.length).toBe(3);
    // 既定（最新）は未解決のみ、includeResolved=1 で解決済みも
    const cur = await op.get(`/api/app/projects/${projectId}/versions/${v1}/instructions`);
    expect(cur.body.pins.map((p: { number: number }) => p.number)).toEqual([1, 2, 3, 5]);
    const all = await op.get(`/api/app/projects/${projectId}/versions/${v1}/instructions?includeResolved=1`);
    expect(all.body.pins.map((p: { number: number }) => p.number)).toEqual([1, 2, 3, 4, 5]);
    expect(all.body.text).toContain('④ [追加]（対応済み）');
  });

  it('認可: 他の運営者・他案件の顧客・別運営者の顧客は 404、他版の修正依頼IDも 404', async () => {
    expect((await opB.get(`/api/app/projects/${projectId}/versions/${v1}/instructions`)).status).toBe(404);
    expect((await opB.get(`/api/app/projects/${projectB}/versions/${v1}/instructions`)).status).toBe(404);
    expect((await otherClient.get(`/api/portal/projects/${projectId}/versions/${v1}/instructions`)).status).toBe(404);
    expect((await otherClient.get(`/api/portal/projects/${otherProjectId}/versions/${v1}/instructions`)).status).toBe(404);
    expect((await clientB.get(`/api/portal/projects/${projectB}/versions/${v1}/instructions?format=txt`)).status).toBe(404);
    expect((await client.get(`/api/portal/projects/${projectId}/versions/${v1}/instructions?changeRequestId=chg_doesnotexist`)).status).toBe(404);
    // 顧客Cookieで管理API、運営者Cookieで顧客API
    expect((await client.get(`/api/app/projects/${projectId}/versions/${v1}/instructions`)).status).toBe(401);
    expect((await op.get(`/api/portal/projects/${projectId}/versions/${v1}/instructions`)).status).toBe(401);
  });
});

describe('Client Portal 写真セレクト（API）', () => {
  let sid: string;
  const S = () => `/api/app/projects/${projectId}/selections/${sid}`;
  const C = () => `/api/portal/projects/${projectId}/selections/${sid}`;
  const up = (name: string, data: Buffer, setId = sid, agent = op, pid = projectId) =>
    upload(agent, `/api/app/projects/${pid}/uploads`, name, data, { target: { purpose: 'selection_photo', setId } });

  it('作成→写真を登録（画像のみ・同じ写真は二重登録不可・同名の別写真は「同名あり」）', async () => {
    const r = await op.post(`/api/app/projects/${projectId}/selections`, { title: '撮影セレクト', message: '使いたい写真の番号を選んでください' });
    expect(r.status).toBe(200);
    sid = r.body.id;
    for (const [i, name] of ['IMG_10.jpg.png', 'IMG_2.png', 'IMG_1.png', 'IMG_2.png'].entries()) {
      const u = await up(name, makePng(100 + i));
      expect(u.status, JSON.stringify(u.body)).toBe(200);
      expect(u.body.file.purpose).toBe('selection_photo');
    }
    const dup = await up('copy.png', makePng(101));
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('duplicate_photo');
    const pdf = await up('doc.pdf', PDF());
    expect(pdf.status).toBe(400);
    expect(pdf.body.error).toBe('not_image');
    const d = await op.get(S());
    expect(d.body.photos.map((p: { number: string; name: string }) => `${p.number}:${p.name}`)).toEqual(['001:IMG_10.jpg.png', '002:IMG_2.png', '003:IMG_1.png', '004:IMG_2.png']);
    expect(d.body.photos.filter((p: { sameName: boolean }) => p.sameName).length).toBe(2);
    expect(d.body.set.status).toBe('draft');
  });

  it('準備中は顧客に見えない（一覧・詳細・写真ファイル）', async () => {
    expect((await client.get(`/api/portal/projects/${projectId}/selections`)).body.selections).toEqual([]);
    expect((await client.get(C())).status).toBe(404);
    const d = await op.get(S());
    const fid = d.body.photos[0].file.id;
    expect((await client.get(`/api/portal/projects/${projectId}/files/${fid}/content`)).status).toBe(404);
  });

  it('準備中: ファイル名順（自然順）・並べ替え・削除で番号を欠番なく振り直す', async () => {
    expect((await op.post(`${S()}/sort-by-name`)).status).toBe(200);
    let d = await op.get(S());
    expect(d.body.photos.map((p: { name: string }) => p.name)).toEqual(['IMG_1.png', 'IMG_2.png', 'IMG_2.png', 'IMG_10.jpg.png']);
    const last = d.body.photos[3].id;
    expect((await op.post(`${S()}/photos/${last}/move`, { toNumber: 1 })).status).toBe(200);
    d = await op.get(S());
    expect(d.body.photos[0]).toMatchObject({ id: last, number: '001' });
    const del = d.body.photos[2];
    expect((await op.post(`${S()}/photos/delete`, { photoIds: [del.id] })).status).toBe(200);
    d = await op.get(S());
    expect(d.body.photos.map((p: { number: string }) => p.number)).toEqual(['001', '002', '003']);
    expect(d.body.photos.map((p: { name: string }) => p.name)).toEqual(['IMG_10.jpg.png', 'IMG_1.png', 'IMG_2.png']);
    // 削除した写真のファイルは消えている
    expect((await op.get(`/api/app/projects/${projectId}/files/${del.file.id}/content`)).status).toBe(404);
    // 追加 → 末尾
    expect((await up('IMG_3.png', makePng(200))).status).toBe(200);
    d = await op.get(S());
    expect(d.body.photos.map((p: { number: string; name: string }) => `${p.number}:${p.name}`)).toEqual(['001:IMG_10.jpg.png', '002:IMG_1.png', '003:IMG_2.png', '004:IMG_3.png']);
  });

  it('公開（顧客へ通知）後は番号が変わる操作を拒否、追加は末尾', async () => {
    expect((await op.post(`${S()}/status`, { status: 'open' })).status).toBe(200);
    const n = await client.get('/api/portal/notifications');
    expect(n.body.notifications.some((x: { kind: string; link: string }) => x.kind === 'selection_opened' && x.link.endsWith(sid))).toBe(true);
    const d = await op.get(S());
    expect((await op.post(`${S()}/sort-by-name`)).status).toBe(409);
    expect((await op.post(`${S()}/photos/${d.body.photos[1].id}/move`, { toNumber: 1 })).status).toBe(409);
    expect((await op.post(`${S()}/photos/delete`, { photoIds: [d.body.photos[1].id] })).status).toBe(409);
    expect((await op.del(S())).status).toBe(409);
    expect((await op.post(`/api/app/projects/${projectId}/files/${d.body.photos[0].file.id}/withdraw`)).status).toBe(409);
    expect((await up('IMG_4.png', makePng(201))).status).toBe(200);
    const d2 = await op.get(S());
    expect(d2.body.photos.length).toBe(5);
    expect(d2.body.photos[4]).toMatchObject({ number: '005', name: 'IMG_4.png' });
    expect(d2.body.photos.slice(0, 4).map((p: { id: string }) => p.id)).toEqual(d.body.photos.map((p: { id: string }) => p.id));
  });

  it('顧客: 一覧・詳細・写真取得、番号入力（読めない語・該当なし・重複を報告）とクリック選択、送信で運営者へ通知', async () => {
    const list = await client.get(`/api/portal/projects/${projectId}/selections`);
    expect(list.body.selections).toHaveLength(1);
    expect(list.body.selections[0]).toMatchObject({ id: sid, photoCount: 5, myPickCount: 0, submittedAt: null });
    const home = await client.get(`/api/portal/projects/${projectId}`);
    expect(home.body.todo.selections).toEqual([{ id: sid, title: '撮影セレクト', submitted: false }]);
    const d = await client.get(C());
    expect(d.status).toBe(200);
    expect(d.body.photos.map((p: { number: string; name: string }) => `${p.number}:${p.name}`)).toEqual([
      '001:IMG_10.jpg.png',
      '002:IMG_1.png',
      '003:IMG_2.png',
      '004:IMG_3.png',
      '005:IMG_4.png',
    ]);
    const img = await client.get(d.body.photos[0].url);
    expect(img.status).toBe(200);
    expect(String(img.headers['content-type'])).toBe('image/png');
    // 番号入力
    const r = await client.post(`${C()}/picks`, { numbersText: '001, 4、abc 003 003 9', mode: 'add' });
    expect(r.status).toBe(200);
    expect(r.body.check.invalid).toEqual(['abc']);
    expect(r.body.check.duplicates).toEqual([{ label: '003', count: 2 }]);
    expect(r.body.check.results.map((x: { label: string; found: boolean }) => [x.label, x.found])).toEqual([
      ['001', true],
      ['004', true],
      ['003', true],
      ['009', false],
    ]);
    expect(r.body.check.results[1]).toMatchObject({ input: '4', name: 'IMG_3.png' });
    let d2 = await client.get(C());
    expect(d2.body.photos.filter((p: { picked: boolean }) => p.picked).map((p: { number: string }) => p.number)).toEqual(['001', '003', '004']);
    // クリック選択（置き換え）
    const ids = d2.body.photos.filter((p: { number: string }) => ['001', '002', '004'].includes(p.number)).map((p: { id: string }) => p.id);
    expect((await client.post(`${C()}/picks`, { photoIds: ids })).status).toBe(200);
    d2 = await client.get(C());
    expect(d2.body.photos.filter((p: { picked: boolean }) => p.picked).map((p: { number: string }) => p.number)).toEqual(['001', '002', '004']);
    // 送信
    const s = await client.post(`${C()}/submit`, { note: '001を表紙に' });
    expect(s.status).toBe(200);
    expect(s.body.count).toBe(3);
    const n = await op.get('/api/app/notifications');
    expect(n.body.notifications.some((x: { kind: string; body: string }) => x.kind === 'selection_submitted' && x.body === '001, 002, 004')).toBe(true);
    const act = await client.get(`/api/portal/projects/${projectId}/activity`);
    expect(act.body.events.some((e: { action: string }) => e.action === 'selection.submitted')).toBe(true);
    const home2 = await client.get(`/api/portal/projects/${projectId}`);
    expect(home2.body.todo.selections[0].submitted).toBe(true);
  });

  it('運営者: 番号→元ファイル名の対応で結果を確認し、CSV/テキストで書き出せる', async () => {
    const d = await op.get(S());
    expect(d.body.responses).toHaveLength(1);
    expect(d.body.responses[0]).toMatchObject({ clientName: '山田 太郎', note: '001を表紙に', changedAfterSubmit: false });
    expect(d.body.responses[0].picks.map((p: { number: string; name: string }) => `${p.number}:${p.name}`)).toEqual(['001:IMG_10.jpg.png', '002:IMG_1.png', '004:IMG_3.png']);
    const csv = await op.get(`${S()}/export?kind=picks&format=csv`);
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toMatch(/text\/csv/);
    expect(csv.raw.toString('utf8')).toBe('﻿番号,元ファイル名\r\n001,IMG_10.jpg.png\r\n002,IMG_1.png\r\n004,IMG_3.png\r\n');
    const txt = (await op.get(`${S()}/export?kind=picks&format=txt`)).raw.toString('utf8');
    expect(txt).toContain('004 → IMG_3.png');
    expect(txt).toContain('選んだ人：山田 太郎');
    const map = (await op.get(`${S()}/export?kind=map&format=csv`)).raw.toString('utf8');
    expect(map.split('\r\n').length).toBe(7); // ヘッダ + 5件 + 末尾改行
    expect(map).toContain('005,IMG_4.png');
    // 送信後の変更は「変更あり（未送信）」として分かる
    await client.post(`${C()}/picks`, { numbersText: '5', mode: 'add' });
    const d2 = await op.get(S());
    expect(d2.body.responses[0].changedAfterSubmit).toBe(true);
  });

  it('元ファイル名を見せない設定: 顧客APIに名前を出さず、ファイルのヘッダも番号名', async () => {
    expect((await op.patch(S(), { showNames: false })).status).toBe(200);
    const d = await client.get(C());
    expect(d.body.photos.every((p: { name: string | null }) => p.name === null)).toBe(true);
    expect(JSON.stringify(d.body)).not.toContain('IMG_');
    const r = await client.post(`${C()}/picks`, { numbersText: '002', mode: 'add' });
    expect(r.body.check.results[0].name).toBe('002');
    const f = await client.get(`${d.body.photos[1].url}?dl=1`);
    expect(String(f.headers['content-disposition'])).toContain('002.png');
    expect(String(f.headers['content-disposition'])).not.toContain('IMG_');
    await op.patch(S(), { showNames: true });
  });

  it('認可: 他運営者・他案件の顧客・別運営者の顧客は 404、他セットの写真IDで選択不可、顧客は写真を追加できない', async () => {
    expect((await opB.get(S())).status).toBe(404);
    expect((await opB.get(`/api/app/projects/${projectB}/selections/${sid}`)).status).toBe(404);
    expect((await opB.post(`/api/app/projects/${projectId}/selections/${sid}/status`, { status: 'closed' })).status).toBe(404);
    expect((await opB.get(`/api/app/projects/${projectId}/selections/${sid}/export?kind=picks`)).status).toBe(404);
    // 他運営者が自分の案件のアップロードで他人のセットIDを指定
    expect((await up('x.png', makePng(300), sid, opB, projectB)).status).toBe(404);
    expect((await otherClient.get(C())).status).toBe(404);
    expect((await otherClient.get(`/api/portal/projects/${otherProjectId}/selections/${sid}`)).status).toBe(404);
    expect((await otherClient.post(`/api/portal/projects/${otherProjectId}/selections/${sid}/picks`, { numbersText: '1' })).status).toBe(404);
    expect((await clientB.get(`/api/portal/projects/${projectB}/selections/${sid}`)).status).toBe(404);
    const d = await op.get(S());
    const fid = d.body.photos[0].file.id;
    expect((await otherClient.get(`/api/portal/projects/${otherProjectId}/files/${fid}/content`)).status).toBe(404);
    expect((await clientB.get(`/api/portal/projects/${projectB}/files/${fid}/content`)).status).toBe(404);
    // 別セット（準備中）の写真IDを混ぜた選択は拒否
    const s2 = (await op.post(`/api/app/projects/${projectId}/selections`, { title: '別セット' })).body.id;
    expect((await up('other.png', makePng(400), s2)).status).toBe(200);
    const other = (await op.get(`/api/app/projects/${projectId}/selections/${s2}`)).body.photos[0].id;
    expect((await client.post(`${C()}/picks`, { photoIds: [other] })).status).toBe(404);
    // 顧客の管理API・顧客のアップロード先指定
    expect((await client.get(`/api/app/projects/${projectId}/selections`)).status).toBe(401);
    expect((await client.post(`/api/portal/projects/${projectId}/uploads`, { name: 'a.png', size: 10, target: { purpose: 'selection_photo', setId: sid } })).status).toBe(400);
    // 準備中のセットは削除でき、写真ファイルも消える
    expect((await op.del(`/api/app/projects/${projectId}/selections/${s2}`)).status).toBe(200);
    expect((await op.get(`/api/app/projects/${projectId}/selections/${s2}`)).status).toBe(404);
  });

  it('受付終了で顧客の変更・送信を拒否、閲覧は可能。再開で再び選択可能', async () => {
    expect((await op.post(`${S()}/status`, { status: 'closed' })).status).toBe(200);
    expect((await client.post(`${C()}/picks`, { numbersText: '1' })).status).toBe(409);
    expect((await client.post(`${C()}/submit`, {})).status).toBe(409);
    expect((await client.get(C())).status).toBe(200);
    expect((await up('late.png', makePng(500))).status).toBe(409);
    expect((await op.post(`${S()}/status`, { status: 'open' })).status).toBe(200);
    expect((await client.post(`${C()}/picks`, { numbersText: '1' })).status).toBe(200);
  });

  it('バックアップに写真セレクトの件数が含まれ、案件削除でセットと写真が消える', async () => {
    const { dir, manifest } = await createBackup(loadConfig({ dataDir }), tmpDir('cp-bk-sel-'));
    expect(manifest.counts.selection_sets).toBeGreaterThan(0);
    expect(manifest.counts.selection_photos).toBe(5);
    expect((await verifyBackup(dir)).ok).toBe(true);
    const name = (await op.get(`/api/app/projects/${projectId}`)).body.project.name;
    const del = await op.del(`/api/app/projects/${projectId}`, { confirmName: name });
    expect(del.status).toBe(200);
    const db = app.ctx.db;
    expect((db.prepare('SELECT COUNT(*) n FROM selection_sets WHERE project_id = ?').get(projectId) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM selection_photos WHERE project_id = ?').get(projectId) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM files WHERE project_id = ?').get(projectId) as { n: number }).n).toBe(0);
  });
});

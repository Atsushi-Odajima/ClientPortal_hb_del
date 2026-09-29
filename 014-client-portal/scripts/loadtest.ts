// 負荷試験: npx tsx scripts/loadtest.ts
// 案件1,000 / 顧客500 / ファイルメタデータ50,000 / コメント100,000 を生成し、主要一覧・検索・認可の応答時間を計測する。
// ファイル実体は作成しない（ストレージ費用・容量は別途 OPERATING_COSTS.md の方法で試算）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/src/app.js';
import { hashPassword } from '../server/src/auth.js';
import { newId, sha256Hex } from '../server/src/util.js';

const N = { clients: 500, projects: 1000, deliverablesPerProject: 5, versionsPerDeliverable: 2, filesTotal: 50_000, commentsTotal: 100_000 };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-load-'));
const app = await buildApp({ config: { dataDir, logLevel: 'silent', passwordScryptN: 16384, webDist: path.join(dataDir, 'x'), publicUrl: 'http://localhost:0' } });
const db = app.ctx.db;
const now = new Date().toISOString();
const t0 = Date.now();

const opId = newId('op');
const otherOp = newId('op');
const pw = await hashPassword('correct horse battery', 16384);
db.prepare('INSERT INTO operators (id, email, name, business_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(opId, 'load@example.com', '負荷', '負荷スタジオ', pw, now, now);
db.prepare('INSERT INTO operators (id, email, name, business_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(otherOp, 'other@example.com', '他者', '', pw, now, now);

const statuses = ['preparing', 'waiting_materials', 'in_production', 'client_review', 'revising', 'approved', 'delivered', 'completed'];
const clientIds: string[] = [];
const projectIds: string[] = [];
const versionIds: { id: string; pid: string; did: string }[] = [];
let fileCount = 0;
db.transaction(() => {
  const insC = db.prepare('INSERT INTO clients (id, owner_id, company_name, contact_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < N.clients; i++) {
    const id = newId('cli');
    clientIds.push(id);
    insC.run(id, opId, `顧客${i}株式会社`, `担当${i}`, `client${i}@example.com`, now, now);
  }
  const insP = db.prepare(
    `INSERT INTO projects (id, owner_id, client_id, name, status, portal_status, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)`,
  );
  const insA = db.prepare(`INSERT INTO portal_access (id, project_id, client_id, status, created_at) VALUES (?, ?, ?, 'active', ?)`);
  const insR = db.prepare(`INSERT INTO document_requests (id, project_id, title, kind, status, sort_order, due_date, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?)`);
  const insD = db.prepare('INSERT INTO deliverables (id, project_id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insF = db.prepare(
    `INSERT INTO files (id, project_id, owner_id, uploader_type, uploader_id, original_name, storage_key, mime, size, sha256, purpose, request_id, version_group_id, version_number, preview_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'image/png', 123456, ?, ?, ?, ?, ?, 'image', ?)`,
  );
  const insV = db.prepare(
    `INSERT INTO deliverable_versions (id, deliverable_id, project_id, version_number, file_id, status, submitted_by, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < N.projects; i++) {
    const pid = newId('prj');
    projectIds.push(pid);
    const cid = clientIds[i % N.clients];
    const due = new Date(Date.now() + ((i % 60) - 20) * 86400_000).toISOString().slice(0, 10);
    insP.run(pid, opId, cid, `案件${i} ${['LP制作', 'SNS運用', '動画編集', 'バナー制作'][i % 4]}`, statuses[i % statuses.length], due, now, now);
    insA.run(newId('acc'), pid, cid, now);
    for (let r = 0; r < 4; r++) insR.run(newId('req'), pid, `資料${r}`, ['pending', 'submitted', 'accepted', 'returned'][(i + r) % 4], r, due, now, now);
    for (let d = 0; d < N.deliverablesPerProject; d++) {
      const did = newId('dlv');
      insD.run(did, pid, `制作物${d}`, d, now, now);
      for (let v = 1; v <= N.versionsPerDeliverable; v++) {
        const fid = newId('fil');
        insF.run(fid, pid, opId, 'operator', opId, `design_${i}_${d}_v${v}.png`, `p/${pid}/${fid}`, sha256Hex(fid), 'deliverable_version', null, did, v, now);
        fileCount++;
        const vid = newId('ver');
        const st = v < N.versionsPerDeliverable ? 'superseded' : ['in_review', 'changes_requested', 'approved'][(i + d) % 3];
        insV.run(vid, did, pid, v, fid, st, opId, now);
        versionIds.push({ id: vid, pid, did });
      }
    }
  }
  // 残りのファイルメタデータを顧客提出として追加
  const reqs = db.prepare('SELECT id, project_id FROM document_requests').all() as { id: string; project_id: string }[];
  let k = 0;
  while (fileCount < N.filesTotal) {
    const r = reqs[k++ % reqs.length];
    const fid = newId('fil');
    insF.run(fid, r.project_id, opId, 'client', 'x', `photo_${fileCount}.jpg`, `p/${r.project_id}/${fid}`, sha256Hex(fid), 'request_attachment', r.id, null, null, now);
    fileCount++;
  }
  const insCm = db.prepare(
    `INSERT INTO comments (id, project_id, deliverable_id, version_id, author_type, author_id, author_name, body, pin_x, pin_y, pin_number, created_at) VALUES (?, ?, ?, ?, 'client', 'x', '担当', ?, ?, ?, ?, ?)`,
  );
  for (let c = 0; c < N.commentsTotal; c++) {
    const v = versionIds[c % versionIds.length];
    const pin = c % 3 === 0;
    insCm.run(newId('cmt'), v.pid, v.did, v.id, `コメント${c} 文字を大きく`, pin ? 0.5 : null, pin ? 0.3 : null, pin ? c : null, now);
  }
})();
const seedMs = Date.now() - t0;

// ログインセッション
const login = async (email: string) => {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json', 'x-cp-csrf': '1' }, payload: JSON.stringify({ email, password: 'correct horse battery' }) });
  return String(r.headers['set-cookie']).split(';')[0];
};
const opCookie = await login('load@example.com');
const otherCookie = await login('other@example.com');
// 顧客セッション（招待を直接作成）
const clientCookie = await (async () => {
  const acc = db.prepare('SELECT id FROM portal_access WHERE project_id = ?').get(projectIds[0]) as { id: string };
  const token = 'L'.repeat(43);
  db.prepare(`INSERT INTO invites (id, access_id, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, 'x', ?)`).run(newId('inv'), acc.id, sha256Hex(token), new Date(Date.now() + 86400_000).toISOString(), now);
  const r = await app.inject({ method: 'POST', url: '/api/invite/redeem', headers: { 'content-type': 'application/json', 'x-cp-csrf': '1' }, payload: JSON.stringify({ token, email: 'client0@example.com' }) });
  return String(r.headers['set-cookie']).split(';')[0];
})();

const pid = projectIds[0];
const did = versionIds[0].did;
const someFile = (db.prepare('SELECT id FROM files WHERE project_id = ? LIMIT 1').get(pid) as { id: string }).id;
const cases: { name: string; url: string; cookie: string; expect: number }[] = [
  { name: 'ダッシュボード', url: '/api/app/dashboard', cookie: opCookie, expect: 200 },
  { name: '案件一覧（既定50件）', url: '/api/app/projects', cookie: opCookie, expect: 200 },
  { name: '案件一覧（状態絞込）', url: '/api/app/projects?status=client_review', cookie: opCookie, expect: 200 },
  { name: '案件一覧（承認待ち絞込）', url: '/api/app/projects?approval=pending', cookie: opCookie, expect: 200 },
  { name: '案件一覧（未提出資料あり）', url: '/api/app/projects?pendingRequests=1', cookie: opCookie, expect: 200 },
  { name: '検索（案件名）', url: `/api/app/search?q=${encodeURIComponent('LP制作')}`, cookie: opCookie, expect: 200 },
  { name: '検索（ファイル名）', url: `/api/app/search?q=${encodeURIComponent('photo_4999')}`, cookie: opCookie, expect: 200 },
  { name: '顧客一覧', url: '/api/app/clients', cookie: opCookie, expect: 200 },
  { name: '案件詳細', url: `/api/app/projects/${pid}`, cookie: opCookie, expect: 200 },
  { name: '制作物詳細（コメント込み）', url: `/api/app/projects/${pid}/deliverables/${did}`, cookie: opCookie, expect: 200 },
  { name: '顧客ポータル ホーム', url: `/api/portal/projects/${pid}`, cookie: clientCookie, expect: 200 },
  { name: '顧客ポータル 制作物一覧', url: `/api/portal/projects/${pid}/deliverables`, cookie: clientCookie, expect: 200 },
  { name: '認可拒否（他運営者の案件）', url: `/api/app/projects/${pid}`, cookie: otherCookie, expect: 404 },
  { name: '認可拒否（他運営者のファイル）', url: `/api/app/projects/${pid}/files/${someFile}/content`, cookie: otherCookie, expect: 404 },
  { name: '認可拒否（顧客→他案件）', url: `/api/portal/projects/${projectIds[1]}`, cookie: clientCookie, expect: 404 },
];

function pct(a: number[], p: number) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const ROUNDS = Number(process.env.ROUNDS ?? 30);
const results: { name: string; p50: number; p95: number; max: number; status: number }[] = [];
for (const c of cases) {
  const times: number[] = [];
  let status = 0;
  for (let i = 0; i < ROUNDS + 3; i++) {
    const s = performance.now();
    const r = await app.inject({ method: 'GET', url: c.url, headers: { cookie: c.cookie } });
    const e = performance.now() - s;
    status = r.statusCode;
    if (r.statusCode !== c.expect) throw new Error(`${c.name}: expected ${c.expect} got ${r.statusCode} ${r.body.slice(0, 200)}`);
    if (i >= 3) times.push(e); // ウォームアップ除外
  }
  results.push({ name: c.name, p50: +pct(times, 50).toFixed(1), p95: +pct(times, 95).toFixed(1), max: +Math.max(...times).toFixed(1), status });
}

// 同時10リクエスト × 20回（ダッシュボード＋一覧）
const cs = performance.now();
let reqs = 0;
for (let i = 0; i < 20; i++) {
  await Promise.all(Array.from({ length: 10 }, (_, j) => app.inject({ method: 'GET', url: j % 2 ? '/api/app/dashboard' : '/api/app/projects', headers: { cookie: opCookie } })));
  reqs += 10;
}
const concMs = performance.now() - cs;

const counts = Object.fromEntries(
  ['projects', 'clients', 'files', 'deliverable_versions', 'comments', 'document_requests'].map((t) => [t, (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n]),
);
const dbSize = fs.statSync(path.join(dataDir, 'portal.sqlite')).size;
const out = {
  measuredAt: new Date().toISOString(),
  environment: { node: process.version, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGB: +(os.totalmem() / 1024 ** 3).toFixed(1), method: 'fastify.inject（HTTPスタック内・ネットワーク遅延なし）' },
  counts,
  seedSeconds: +(seedMs / 1000).toFixed(1),
  dbSizeMB: +(dbSize / 1024 / 1024).toFixed(1),
  roundsPerEndpoint: ROUNDS,
  results,
  concurrency: { requests: reqs, parallel: 10, totalMs: +concMs.toFixed(0), reqPerSec: +(reqs / (concMs / 1000)).toFixed(1) },
  rssMB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(0),
};
fs.mkdirSync('test-results', { recursive: true });
fs.writeFileSync('test-results/loadtest.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });

// THIRD_PARTY_NOTICES.txt を生成（本番に含まれる依存 + フロントエンドに同梱されるライブラリ）
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const tree = JSON.parse(execSync('npm ls --omit=dev --all --json', { maxBuffer: 64 * 1024 * 1024 }).toString());
const seen = new Map();
function walk(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    if (!info.version) continue; // 未インストールの任意依存
    const key = `${name}@${info.version}`;
    if (!seen.has(key)) {
      seen.set(key, { name, version: info.version });
      walk(info.dependencies);
    }
  }
}
walk(tree.dependencies);
// フロントエンドのビルド成果物に含まれるライブラリ（devDependencies だが配布物に同梱）
for (const n of ['react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler', 'cookie', 'set-cookie-parser']) {
  const p = path.join('node_modules', n, 'package.json');
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    seen.set(`${n}@${j.version}`, { name: n, version: j.version });
  }
}
const rows = [];
const byLicense = {};
for (const { name, version } of [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = path.join('node_modules', name);
  let license = 'UNKNOWN';
  let text = '';
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    license = typeof j.license === 'string' ? j.license : j.license?.type ?? (j.licenses ? j.licenses.map((l) => l.type).join(' OR ') : 'UNKNOWN');
    const f = fs.readdirSync(dir).find((x) => /^(licen[cs]e|notice|copying)/i.test(x));
    if (f) text = fs.readFileSync(path.join(dir, f), 'utf8').trim();
  } catch {}
  byLicense[license] = (byLicense[license] ?? 0) + 1;
  rows.push({ name, version, license, text });
}
let out = `THIRD_PARTY_NOTICES — Client Portal が使用・同梱するオープンソースソフトウェア\n生成日: ${new Date().toISOString().slice(0, 10)}（scripts/gen-notices.mjs で再生成できます）\n\nライセンス別件数: ${Object.entries(byLicense).map(([k, v]) => `${k}=${v}`).join(', ')}\n\n`;
out += rows.map((r) => `- ${r.name}@${r.version} (${r.license})`).join('\n');
out += '\n\n==== ライセンス全文 ====\n';
for (const r of rows) if (r.text) out += `\n---- ${r.name}@${r.version} (${r.license}) ----\n${r.text}\n`;
fs.mkdirSync('buyer-docs', { recursive: true });
fs.writeFileSync('buyer-docs/THIRD_PARTY_NOTICES.txt', out);
console.log(JSON.stringify(byLicense), rows.length);

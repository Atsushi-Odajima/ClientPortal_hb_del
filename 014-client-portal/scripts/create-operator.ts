// 使い方: npm run create-operator -- <email> <氏名> [屋号]
// パスワードは標準入力から読み込みます（コマンド履歴に残さないため）
import readline from 'node:readline';
import { loadConfig } from '../server/src/config.js';
import { openDb } from '../server/src/db.js';
import { hashPassword, validatePassword } from '../server/src/auth.js';
import { newId, nowIso } from '../server/src/util.js';

const [email, name, business = ''] = process.argv.slice(2);
if (!email || !name) {
  console.error('使い方: npm run create-operator -- <email> <氏名> [屋号]');
  process.exit(2);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pw: string = await new Promise((r) => rl.question('パスワード(10文字以上): ', (a) => { rl.close(); r(a.trim()); }));
const err = validatePassword(pw);
if (err) {
  console.error(err);
  process.exit(1);
}
const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const now = nowIso();
db.prepare('INSERT INTO operators (id, email, name, business_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
  newId('op'), email.toLowerCase(), name, business, await hashPassword(pw, cfg.passwordScryptN), now, now,
);
console.log('運営者を作成しました:', email);
db.close();

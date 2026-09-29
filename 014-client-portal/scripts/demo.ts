// デモ起動: npm run demo
// 本番データとは別の DATA_DIR（既定 ./data-demo）にデモ用運営者とサンプル案件を作成してサーバーを起動します。
import crypto from 'node:crypto';
import path from 'node:path';
process.env.DATA_DIR = process.env.DEMO_DATA_DIR ?? path.resolve('data-demo');
process.env.ALLOW_SIGNUP ??= 'false';
const { buildApp } = await import('../server/src/app.js');
const { hashPassword } = await import('../server/src/auth.js');
const { newId, nowIso } = await import('../server/src/util.js');
const { createSampleProject } = await import('../server/src/services/sample.js');

const app = await buildApp({ startJobs: true });
const { db, cfg } = app.ctx;
const email = 'demo@example.com';
let op = db.prepare('SELECT * FROM operators WHERE email = ?').get(email) as { id: string; email: string; name: string; business_name: string; status: string } | undefined;
if (!op) {
  const password = crypto.randomBytes(9).toString('base64url');
  const id = newId('op');
  const now = nowIso();
  db.prepare('INSERT INTO operators (id, email, name, business_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, email, 'デモ 運営者', 'デモ制作室', await hashPassword(password, cfg.passwordScryptN), now, now,
  );
  op = db.prepare('SELECT * FROM operators WHERE id = ?').get(id) as typeof op;
  const s = await createSampleProject(app.ctx, op!);
  console.log('\n==== デモ環境を作成しました（本番データとは別フォルダ: ' + cfg.dataDir + '）====');
  console.log(`運営者ログイン: ${cfg.publicUrl}/login  メール: ${email}  パスワード: ${password}`);
  console.log(`顧客体験用リンク: ${s.inviteUrl}  （入力するメール: ${s.clientEmail}）`);
  console.log('※パスワードはこの画面にのみ表示されます。忘れた場合は data-demo フォルダを削除して再実行してください。\n');
} else {
  console.log(`\nデモ環境を再利用します（${cfg.dataDir}）。運営者: ${email}\n`);
}
await app.listen({ port: cfg.port, host: cfg.host });
console.log(`起動しました: ${cfg.publicUrl}`);

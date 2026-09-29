// 保守用: 監査ログの削除（運営者アカウントの完全削除・保持期限切れの削除など）
// 使い方:
//   npm run purge-audit -- --before 2024-01-01          指定日より前の監査ログを削除
//   npm run purge-audit -- --owner <operatorId>         指定運営者の監査ログを削除
// 実行前に必ずバックアップを取得してください。通常運用では使用しません。
import { loadConfig } from '../server/src/config.js';
import { openDb } from '../server/src/db.js';

const args = process.argv.slice(2);
const before = args[args.indexOf('--before') + 1];
const owner = args[args.indexOf('--owner') + 1];
if (!args.includes('--before') && !args.includes('--owner')) {
  console.error('使い方: npm run purge-audit -- --before YYYY-MM-DD | --owner <operatorId>');
  process.exit(2);
}
const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const result = db.transaction(() => {
  db.prepare(`INSERT OR IGNORE INTO maintenance_flags(name) VALUES ('audit_purge')`).run();
  try {
    const r = args.includes('--before')
      ? db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(`${before}T00:00:00.000Z`)
      : db.prepare('DELETE FROM audit_log WHERE owner_id = ?').run(owner);
    return r.changes;
  } finally {
    db.prepare(`DELETE FROM maintenance_flags WHERE name = 'audit_purge'`).run();
  }
})();
console.log(`監査ログを ${result} 件削除しました。残りのログは先頭行を起点にハッシュチェーン検証できます。`);
db.close();

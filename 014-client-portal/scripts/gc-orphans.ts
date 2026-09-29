// 使い方: npm run gc-orphans -- [--delete]
// DBに記録のないストレージ上のファイル（案件削除時に削除失敗したもの等）を一覧・削除します。
// --delete を付けない場合は一覧表示のみ（安全）。
import { loadConfig } from '../server/src/config.js';
import { openDb } from '../server/src/db.js';
import { createStorage } from '../server/src/storage/index.js';

const doDelete = process.argv.includes('--delete');
const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const storage = createStorage(cfg);
const known = new Set((db.prepare('SELECT storage_key FROM files').all() as { storage_key: string }[]).map((r) => r.storage_key));
let orphans = 0;
let missing = 0;
for await (const key of storage.list('p/')) {
  if (!known.has(key)) {
    orphans++;
    console.log(`${doDelete ? '削除' : '孤立'}: ${key}`);
    if (doDelete) await storage.delete(key);
  }
}
for (const key of known) {
  if (!(await storage.head(key))) {
    missing++;
    console.log(`実体なし（要確認）: ${key}`);
  }
}
console.log(JSON.stringify({ orphans, deleted: doDelete ? orphans : 0, missingObjects: missing }));
db.close();

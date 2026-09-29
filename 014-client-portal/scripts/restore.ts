// 使い方: （サーバー停止後に）npm run restore -- <バックアップディレクトリ> [--verify-only]
import { loadConfig } from '../server/src/config.js';
import { restoreBackup, verifyBackup } from '../server/src/backup.js';

const dir = process.argv[2];
if (!dir) {
  console.error('使い方: npm run restore -- <バックアップディレクトリ> [--verify-only]');
  process.exit(2);
}
const cfg = loadConfig();
if (process.argv.includes('--verify-only')) {
  const v = await verifyBackup(dir);
  console.log(JSON.stringify({ ok: v.ok, errors: v.errors, fileCount: v.manifest?.fileCount, schemaVersion: v.manifest?.schemaVersion, createdAt: v.manifest?.createdAt }, null, 2));
  process.exit(v.ok ? 0 : 1);
}
try {
  const r = await restoreBackup(cfg, dir, (m) => console.log(m));
  console.log(JSON.stringify({ ok: true, restoredFrom: r.restoredFrom, previousDataMovedTo: r.previousDataMovedTo, counts: r.manifest.counts }, null, 2));
} catch (e) {
  console.error('復元に失敗しました（現行データは変更されていません）:\n', (e as Error).message);
  process.exit(1);
}

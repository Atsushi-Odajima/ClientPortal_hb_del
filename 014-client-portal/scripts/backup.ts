// 使い方: npm run backup -- [出力先ディレクトリ(既定 ./backups)]
import { loadConfig } from '../server/src/config.js';
import { createBackup } from '../server/src/backup.js';

const out = process.argv[2] ?? process.env.BACKUP_DIR ?? './backups';
const cfg = loadConfig();
try {
  const { dir, manifest } = await createBackup(cfg, out, (m) => console.log(m));
  console.log(JSON.stringify({ ok: true, dir, createdAt: manifest.createdAt, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, counts: manifest.counts }, null, 2));
} catch (e) {
  console.error('バックアップに失敗しました:', (e as Error).message);
  process.exit(1);
}

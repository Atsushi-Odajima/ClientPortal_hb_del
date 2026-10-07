import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { APP_VERSION, SCHEMA_VERSION, type AppConfig } from './config.js';
import { migrate, currentSchemaVersion } from './db.js';
import { createStorage, assertSafeKey, type StorageDriver } from './storage/index.js';
import { verifyAuditChain } from './audit.js';

/**
 * バックアップ形式（ディレクトリ）:
 *   manifest.json … 形式・appVersion・schemaVersion・生成日時・件数・ファイル一覧(key/size/sha256)
 *   db.sqlite     … SQLite オンラインバックアップAPIによる一貫したスナップショット
 *   objects/<key> … DBスナップショットが参照するファイル実体のみ
 * DBを先にスナップショットし、そのDBが参照するファイルだけを複製するため DB とファイルの対応が崩れない。
 */

export const BACKUP_FORMAT = 'client-portal-backup';
export const BACKUP_FORMAT_VERSION = 1;

const COUNT_TABLES = [
  'operators',
  'clients',
  'projects',
  'document_requests',
  'files',
  'deliverables',
  'deliverable_versions',
  'comments',
  'change_requests',
  'approvals',
  'deliveries',
  'delivery_items',
  'templates',
  'selection_sets',
  'selection_photos',
  'selection_picks',
  'selection_responses',
  'audit_log',
] as const;

export interface BackupManifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  storageDriver: string;
  counts: Record<string, number>;
  fileCount: number;
  totalBytes: number;
  db: { file: string; sha256: string; size: number };
  files: { key: string; size: number; sha256: string }[];
  auditChain: { ok: boolean; checked: number };
}

async function sha256OfFile(p: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(p)) h.update(c as Buffer);
  return h.digest('hex');
}

function tableCounts(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  // 古いスキーマのバックアップには後から追加したテーブルがないため、存在するテーブルだけ数える
  const exists = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name));
  for (const t of COUNT_TABLES) if (exists.has(t)) out[t] = (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  return out;
}

export async function createBackup(cfg: AppConfig, outRoot: string, log: (m: string) => void = () => undefined): Promise<{ dir: string; manifest: BackupManifest }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(outRoot, `cp-backup-${stamp}`);
  const partial = `${dir}.partial`;
  await fsp.mkdir(path.join(partial, 'objects'), { recursive: true });
  try {
    // 1) DBスナップショット
    const live = new Database(cfg.dbPath, { fileMustExist: true });
    try {
      await live.backup(path.join(partial, 'db.sqlite'));
    } finally {
      live.close();
    }
    const snap = new Database(path.join(partial, 'db.sqlite'), { readonly: true });
    const counts = tableCounts(snap);
    const fileRows = snap.prepare('SELECT storage_key, size, sha256 FROM files ORDER BY storage_key').all() as { storage_key: string; size: number; sha256: string }[];
    const auditChain = verifyAuditChain(snap);
    const schemaVersion = currentSchemaVersion(snap);
    snap.close();
    log(`DB snapshot: ${fileRows.length} files referenced`);
    // 2) 参照されるファイル実体のみ複製し、ハッシュを検証
    const storage = createStorage(cfg);
    const files: BackupManifest['files'] = [];
    let totalBytes = 0;
    for (const r of fileRows) {
      assertSafeKey(r.storage_key);
      const dest = path.join(partial, 'objects', ...r.storage_key.split('/'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const obj = await storage.get(r.storage_key);
      await pipeline(obj.stream, fs.createWriteStream(dest));
      const sha = await sha256OfFile(dest);
      if (sha !== r.sha256) throw new Error(`hash mismatch for ${r.storage_key} (storage content differs from DB record)`);
      files.push({ key: r.storage_key, size: r.size, sha256: sha });
      totalBytes += r.size;
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: APP_VERSION,
      schemaVersion,
      createdAt: new Date().toISOString(),
      storageDriver: storage.name,
      counts,
      fileCount: files.length,
      totalBytes,
      db: { file: 'db.sqlite', sha256: await sha256OfFile(path.join(partial, 'db.sqlite')), size: (await fsp.stat(path.join(partial, 'db.sqlite'))).size },
      files,
      auditChain: { ok: auditChain.ok, checked: auditChain.checked },
    };
    await fsp.writeFile(path.join(partial, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await fsp.rename(partial, dir);
    log(`backup created: ${dir}`);
    return { dir, manifest };
  } catch (e) {
    await fsp.rm(partial, { recursive: true, force: true });
    throw e;
  }
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  manifest?: BackupManifest;
}

/** 復元前検証: manifest・DB整合性・件数・ファイル実体のハッシュ・DBとの対応 */
export async function verifyBackup(dir: string): Promise<VerifyResult> {
  const errors: string[] = [];
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return { ok: false, errors: ['manifest.json が読めません'] };
  }
  if (manifest.format !== BACKUP_FORMAT) errors.push('バックアップ形式が異なります');
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) errors.push('新しい形式のバックアップです。アプリを更新してください');
  if (manifest.schemaVersion > SCHEMA_VERSION) errors.push(`バックアップのスキーマ(${manifest.schemaVersion})が現在のアプリ(${SCHEMA_VERSION})より新しいです`);
  const dbPath = path.join(dir, manifest.db?.file ?? 'db.sqlite');
  if (!fs.existsSync(dbPath)) {
    errors.push('db.sqlite がありません');
    return { ok: false, errors, manifest };
  }
  if ((await sha256OfFile(dbPath)) !== manifest.db.sha256) errors.push('db.sqlite のハッシュが一致しません（破損の可能性）');
  let dbFiles: { storage_key: string; size: number; sha256: string }[] = [];
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const ic = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (ic.integrity_check !== 'ok') errors.push(`DB整合性チェック失敗: ${ic.integrity_check}`);
    const counts = tableCounts(db);
    for (const [k, v] of Object.entries(manifest.counts)) if (counts[k] !== v) errors.push(`件数不一致 ${k}: manifest=${v} db=${counts[k]}`);
    dbFiles = db.prepare('SELECT storage_key, size, sha256 FROM files').all() as typeof dbFiles;
    const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
    if (fkErrors.length > 0) errors.push(`外部キー不整合 ${fkErrors.length}件`);
    const chain = verifyAuditChain(db);
    if (!chain.ok) errors.push(`監査ログのハッシュチェーンが不一致（seq=${chain.brokenAt}）`);
    db.close();
  } catch (e) {
    errors.push(`DBを開けません: ${(e as Error).message}`);
  }
  const manifestByKey = new Map(manifest.files.map((f) => [f.key, f]));
  if (dbFiles.length !== manifest.files.length) errors.push(`ファイル件数不一致: manifest=${manifest.files.length} db=${dbFiles.length}`);
  for (const f of dbFiles) {
    const m = manifestByKey.get(f.storage_key);
    if (!m) {
      errors.push(`manifestにないファイル: ${f.storage_key}`);
      continue;
    }
    if (m.sha256 !== f.sha256) errors.push(`DBとmanifestのハッシュ不一致: ${f.storage_key}`);
    const p = path.join(dir, 'objects', ...f.storage_key.split('/'));
    try {
      const st = await fsp.stat(p);
      if (st.size !== f.size) errors.push(`サイズ不一致: ${f.storage_key}`);
      else if ((await sha256OfFile(p)) !== f.sha256) errors.push(`ファイル破損（ハッシュ不一致）: ${f.storage_key}`);
    } catch {
      errors.push(`ファイル実体がありません: ${f.storage_key}`);
    }
  }
  return { ok: errors.length === 0, errors, manifest };
}

/**
 * 復元: 検証 → ステージング作成 → 入れ替え。失敗時は現行データを変更しない。
 * サーバー停止中に実行すること（OPERATIONS.md 参照）。
 */
export async function restoreBackup(
  cfg: AppConfig,
  dir: string,
  log: (m: string) => void = () => undefined,
): Promise<{ restoredFrom: string; previousDataMovedTo: string | null; manifest: BackupManifest }> {
  const v = await verifyBackup(dir);
  if (!v.ok || !v.manifest) throw new Error(`バックアップ検証に失敗しました:\n- ${v.errors.join('\n- ')}`);
  const manifest = v.manifest;
  log(`verified: ${manifest.fileCount} files, schema v${manifest.schemaVersion}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dataDir = path.resolve(cfg.dataDir);
  const staging = `${dataDir}.restore-staging-${stamp}`;
  await fsp.mkdir(staging, { recursive: true });
  try {
    await fsp.copyFile(path.join(dir, manifest.db.file), path.join(staging, 'portal.sqlite'));
    const stagedDb = new Database(path.join(staging, 'portal.sqlite'));
    stagedDb.pragma('foreign_keys = ON');
    migrate(stagedDb); // 古いスキーマなら現行へ移行
    stagedDb.close();
    let storage: StorageDriver | null = null;
    if (cfg.storage.driver === 's3') {
      // 外部ストレージ: キーはIDベースで不変のため、実体を先にアップロード（既存データを壊さない追加のみ）
      storage = createStorage(cfg);
      for (const f of manifest.files) await storage.putFile(f.key, path.join(dir, 'objects', ...f.key.split('/')), 'application/octet-stream');
    } else {
      for (const f of manifest.files) {
        const dest = path.join(staging, 'objects', ...f.key.split('/'));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(path.join(dir, 'objects', ...f.key.split('/')), dest);
      }
    }
    // ステージングの最終検証
    const check = new Database(path.join(staging, 'portal.sqlite'), { readonly: true });
    const ic = (check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    check.close();
    if (ic !== 'ok') throw new Error('staged DB integrity check failed');
  } catch (e) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw e;
  }
  // 入れ替え（ここまで現行データは無変更）
  let moved: string | null = null;
  if (fs.existsSync(dataDir)) {
    moved = `${dataDir}.before-restore-${stamp}`;
    await fsp.rename(dataDir, moved);
  }
  try {
    await fsp.rename(staging, dataDir);
  } catch (e) {
    if (moved) await fsp.rename(moved, dataDir).catch(() => undefined);
    throw e;
  }
  log(`restored into ${dataDir}${moved ? ` (previous data kept at ${moved})` : ''}`);
  return { restoredFrom: dir, previousDataMovedTo: moved, manifest };
}

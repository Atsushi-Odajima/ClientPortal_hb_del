import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from './config.js';

export type DB = Database.Database;

const here = path.dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  // dev(tsx): server/src -> server/migrations, build: dist/server -> server/migrations (copied)
  const candidates = [
    path.resolve(here, '../migrations'), // server/src (tsx)
    path.resolve(here, '../../../server/migrations'), // dist/server/src (build)
    path.resolve(process.cwd(), 'server/migrations'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('migrations directory not found');
}

export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
  const dir = migrationsDir();
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const version = Number(f.split('_')[0]);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    })();
  }
}

export function currentSchemaVersion(db: DB): number {
  const row = db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

export { SCHEMA_VERSION };

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertSafeKey, type GetResult, type StorageDriver } from './index.js';

export class LocalStorage implements StorageDriver {
  readonly name = 'local';
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('path traversal');
    return p;
  }

  async putFile(key: string, localPath: string): Promise<void> {
    const dest = this.pathFor(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    await fsp.copyFile(localPath, tmp);
    const fh = await fsp.open(tmp, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, dest);
  }

  async get(key: string, range?: { start: number; end?: number }): Promise<GetResult> {
    const p = this.pathFor(key);
    const st = await fsp.stat(p);
    if (range) {
      const end = Math.min(range.end ?? st.size - 1, st.size - 1);
      return { stream: fs.createReadStream(p, { start: range.start, end }), size: st.size, start: range.start, end };
    }
    return { stream: fs.createReadStream(p), size: st.size };
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const st = await fsp.stat(this.pathFor(key));
      return { size: st.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await fsp.rm(this.pathFor(key), { force: true });
  }

  async *list(prefix = ''): AsyncIterable<string> {
    const root = path.resolve(this.root);
    async function* walk(dir: string): AsyncIterable<string> {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(full);
        else if (e.isFile() && !e.name.includes('.tmp-')) yield path.relative(root, full).split(path.sep).join('/');
      }
    }
    for await (const k of walk(root)) if (k.startsWith(prefix)) yield k;
  }

  async signedDownloadUrl(): Promise<string | null> {
    return null;
  }
}

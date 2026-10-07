import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/src/app.js';
import type { AppConfig } from '../server/src/config.js';

export const SAMPLE_DIR = path.resolve(__dirname, '../server/assets/sample');

export function tmpDir(prefix = 'cp-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function makeApp(overrides: Partial<AppConfig> = {}): Promise<{ app: FastifyInstance; dataDir: string }> {
  const dataDir = overrides.dataDir ?? tmpDir();
  const app = await buildApp({
    config: {
      dataDir,
      passwordScryptN: 1024,
      logLevel: 'silent',
      allowSignup: true,
      publicUrl: 'http://localhost:8787',
      webDist: path.join(dataDir, 'no-web'),
      ...overrides,
      limits: {
        maxUploadBytes: 5 * 1024 * 1024,
        chunkBytes: 256 * 1024,
        maxActiveProjectsPerOperator: 0,
        maxProjectStorageBytes: 0,
        maxZipBytes: 50 * 1024 * 1024,
        ...(overrides.limits ?? {}),
      },
    },
  });
  return { app, dataDir };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
  raw: Buffer;
}

/** Cookieを保持するテスト用クライアント（ブラウザ1台に相当） */
export class Agent {
  cookies = new Map<string, string>();
  constructor(public app: FastifyInstance, public csrf = true) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private store(setCookie: string | string[] | undefined) {
    if (!setCookie) return;
    for (const c of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (!v || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }

  async req<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const h: Record<string, string> = { ...headers };
    if (this.cookies.size) h.cookie = this.cookieHeader();
    if (this.csrf && method !== 'GET') h['x-cp-csrf'] = '1';
    let payload: string | Buffer | undefined;
    if (Buffer.isBuffer(body)) {
      payload = body;
      h['content-type'] = h['content-type'] ?? 'application/octet-stream';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['content-type'] = 'application/json';
    }
    const res = await this.app.inject({ method: method as 'GET', url, payload, headers: h });
    this.store(res.headers['set-cookie']);
    let parsed: any = res.body;
    const ct = String(res.headers['content-type'] ?? '');
    if (ct.includes('application/json')) parsed = res.json();
    return { status: res.statusCode, body: parsed, headers: res.headers as Res['headers'], raw: res.rawPayload };
  }

  get<T = any>(url: string, headers?: Record<string, string>) {
    return this.req<T>('GET', url, undefined, headers);
  }
  post<T = any>(url: string, body?: unknown) {
    return this.req<T>('POST', url, body ?? {});
  }
  patch<T = any>(url: string, body?: unknown) {
    return this.req<T>('PATCH', url, body ?? {});
  }
  del<T = any>(url: string, body?: unknown) {
    return this.req<T>('DELETE', url, body);
  }
}

let seq = 0;
export async function newOperator(app: FastifyInstance, name = 'Op'): Promise<Agent> {
  const a = new Agent(app);
  seq++;
  const r = await a.post('/api/auth/signup', { email: `op${seq}-${Date.now()}@example.com`, name: `${name}${seq}`, businessName: `${name} Studio`, password: 'correct horse battery' });
  if (r.status !== 200) throw new Error(`signup failed ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

export async function createClientAndProject(op: Agent, email = `client${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`) {
  const c = await op.post('/api/app/clients', { companyName: 'テスト株式会社', contactName: '山田 太郎', email });
  if (c.status !== 200) throw new Error(JSON.stringify(c.body));
  const p = await op.post('/api/app/projects', { clientId: c.body.id, name: 'テスト案件', description: 'desc', internalMemo: '社外秘メモ' });
  if (p.status !== 200) throw new Error(JSON.stringify(p.body));
  return { clientId: c.body.id as string, projectId: p.body.id as string, email };
}

/** 招待リンクから顧客としてログインしたAgentを返す */
export async function inviteClient(app: FastifyInstance, op: Agent, projectId: string, email: string): Promise<{ client: Agent; token: string; inviteId: string }> {
  const inv = await op.post(`/api/app/projects/${projectId}/invites`, { days: 7 });
  if (inv.status !== 200) throw new Error(JSON.stringify(inv.body));
  const token = String(inv.body.url).split('#t=')[1];
  const client = new Agent(app);
  const r = await client.post('/api/invite/redeem', { token, email });
  if (r.status !== 200) throw new Error(`redeem failed ${JSON.stringify(r.body)}`);
  return { client, token, inviteId: inv.body.inviteId };
}

/** 分割アップロード（init → chunks → complete） */
export async function upload(
  agent: Agent,
  initUrl: string,
  name: string,
  data: Buffer,
  extra: Record<string, unknown>,
): Promise<Res> {
  const init = await agent.post(initUrl, { name, size: data.length, ...extra });
  if (init.status !== 200) return init;
  const { uploadId, chunkSize, chunkCount } = init.body;
  for (let i = 0; i < chunkCount; i++) {
    const r = await agent.req('PUT', `/api/uploads/${uploadId}/chunks/${i}`, data.subarray(i * chunkSize, (i + 1) * chunkSize));
    if (r.status !== 200) return r;
  }
  return agent.post(`/api/uploads/${uploadId}/complete`);
}

export const PNG = () => fs.readFileSync(path.join(SAMPLE_DIR, 'post-a-v1.png'));
export const PNG2 = () => fs.readFileSync(path.join(SAMPLE_DIR, 'post-a-v2.png'));
export const PNG3 = () => fs.readFileSync(path.join(SAMPLE_DIR, 'post-b-v1.png'));
export const PDF = () =>
  Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  );

export async function submitVersion(op: Agent, projectId: string, deliverableId: string, data: Buffer, name = 'design.png', note = '') {
  return upload(op, `/api/app/projects/${projectId}/uploads`, name, data, { target: { purpose: 'deliverable_version', deliverableId, note } });
}

export function idem(): string {
  return `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}xxxxxxxx`.slice(0, 32);
}

/** テスト用の小さな PNG を生成（seed ごとに内容＝ハッシュが異なる） */
export function makePng(seed: number, width = 4, height = 3): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width * 3; x++) raw[y * (width * 3 + 1) + 1 + x] = (seed * 37 + x * 11 + y * 7) & 0xff;
  }
  raw.writeUInt32BE(seed >>> 0, 1); // 先頭画素に seed を埋め込み、内容を一意にする
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

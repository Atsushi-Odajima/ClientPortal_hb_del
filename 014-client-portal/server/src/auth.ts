import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ClientRow, Ctx, OperatorRow } from './context.js';
import type { DB } from './db.js';
import { HttpError, addDays, nowIso, newToken, sha256Hex, timingSafeEqualStr } from './util.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

export const OPERATOR_COOKIE = 'cp_op';
export const CLIENT_COOKIE = 'cp_cl';

export async function hashPassword(pw: string, N: number): Promise<string> {
  const salt = crypto.randomBytes(16);
  const r = 8;
  const p = 1;
  const key = await scrypt(pw, salt, 64, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const key = await scrypt(pw, salt, expected.length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  return crypto.timingSafeEqual(key, expected);
}

/** 失敗時の処理時間を揃えるためのダミー照合 */
let dummyHash: string | null = null;
export async function dummyVerify(N: number): Promise<void> {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password', N);
  await verifyPassword('not-the-password', dummyHash);
}

function cookieOpts(ctx: Ctx, days: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: ctx.cfg.secureCookies,
    path: '/',
    maxAge: days * 86400,
  };
}

export function createOperatorSession(ctx: Ctx, reply: FastifyReply, operatorId: string, ua: string): void {
  const token = newToken();
  const now = new Date();
  ctx.db
    .prepare('INSERT INTO operator_sessions (id_hash, operator_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256Hex(token), operatorId, now.toISOString(), addDays(now, ctx.cfg.sessions.operatorDays).toISOString(), now.toISOString(), ua.slice(0, 180));
  reply.setCookie(OPERATOR_COOKIE, token, cookieOpts(ctx, ctx.cfg.sessions.operatorDays));
}

export function createClientSession(ctx: Ctx, reply: FastifyReply, clientId: string, inviteId: string | null, ua: string): void {
  const token = newToken();
  const now = new Date();
  ctx.db
    .prepare('INSERT INTO client_sessions (id_hash, client_id, invite_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha256Hex(token), clientId, inviteId, now.toISOString(), addDays(now, ctx.cfg.sessions.clientDays).toISOString(), now.toISOString(), ua.slice(0, 180));
  reply.setCookie(CLIENT_COOKIE, token, cookieOpts(ctx, ctx.cfg.sessions.clientDays));
}

export function clearCookie(ctx: Ctx, reply: FastifyReply, name: string): void {
  reply.clearCookie(name, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.cfg.secureCookies });
}

function touch(db: DB, table: 'operator_sessions' | 'client_sessions', idHash: string, lastSeen: string): void {
  // 5分に1回だけ更新（書き込み削減）
  if (Date.now() - Date.parse(lastSeen) > 5 * 60_000) {
    db.prepare(`UPDATE ${table} SET last_seen_at = ? WHERE id_hash = ?`).run(nowIso(), idHash);
  }
}

export function resolveOperator(ctx: Ctx, req: FastifyRequest): OperatorRow | null {
  const token = req.cookies[OPERATOR_COOKIE];
  if (!token || token.length > 100) return null;
  const idHash = sha256Hex(token);
  const row = ctx.db
    .prepare(
      `SELECT s.id_hash, s.expires_at, s.last_seen_at, o.id, o.email, o.name, o.business_name, o.status
       FROM operator_sessions s JOIN operators o ON o.id = s.operator_id WHERE s.id_hash = ?`,
    )
    .get(idHash) as (OperatorRow & { id_hash: string; expires_at: string; last_seen_at: string }) | undefined;
  if (!row || !timingSafeEqualStr(row.id_hash, idHash)) return null;
  if (Date.parse(row.expires_at) < Date.now() || row.status !== 'active') return null;
  touch(ctx.db, 'operator_sessions', idHash, row.last_seen_at);
  return { id: row.id, email: row.email, name: row.name, business_name: row.business_name, status: row.status };
}

export function resolveClient(ctx: Ctx, req: FastifyRequest): (ClientRow & { session_hash: string }) | null {
  const token = req.cookies[CLIENT_COOKIE];
  if (!token || token.length > 100) return null;
  const idHash = sha256Hex(token);
  const row = ctx.db
    .prepare(
      `SELECT s.id_hash AS session_hash, s.expires_at AS s_expires, s.last_seen_at AS s_seen, c.*
       FROM client_sessions s JOIN clients c ON c.id = s.client_id WHERE s.id_hash = ?`,
    )
    .get(idHash) as (ClientRow & { session_hash: string; s_expires: string; s_seen: string }) | undefined;
  if (!row) return null;
  if (Date.parse(row.s_expires) < Date.now() || row.status !== 'active') return null;
  touch(ctx.db, 'client_sessions', idHash, row.s_seen);
  return row;
}

export function requireOperator(ctx: Ctx, req: FastifyRequest): OperatorRow {
  const op = resolveOperator(ctx, req);
  if (!op) throw new HttpError(401, 'unauthenticated', 'ログインしてください');
  return op;
}

export function requireClient(ctx: Ctx, req: FastifyRequest): ClientRow & { session_hash: string } {
  const c = resolveClient(ctx, req);
  if (!c) throw new HttpError(401, 'unauthenticated', 'ポータルへのアクセス権がありません。招待リンクから開いてください');
  return c;
}

export function validatePassword(pw: string): string | null {
  if (pw.length < 10) return 'パスワードは10文字以上にしてください';
  if (pw.length > 200) return 'パスワードが長すぎます';
  return null;
}

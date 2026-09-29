import { z } from 'zod';
import crypto from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 推測困難なID（prefix_ + 22文字 base62 ≒ 131bit） */
export function newId(prefix: string): string {
  const bytes = crypto.randomBytes(22);
  let out = '';
  for (const b of bytes) out += BASE62[b % 62];
  // 256 は 62 で割り切れないため極小の偏りがあるが、IDの推測困難性には影響しない（>128bit）
  return `${prefix}_${out}`;
}

/** 招待・セッション用の高エントロピートークン（256bit, base64url） */
export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hmacHex(secret: string, input: string): string {
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400_000);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export const notFound = (what = 'リソース') => new HttpError(404, 'not_found', `${what}が見つかりません`);
export const forbidden = (msg = 'この操作は許可されていません') => new HttpError(403, 'forbidden', msg);
export const badRequest = (msg: string, code = 'bad_request', extra?: Record<string, unknown>) => new HttpError(400, code, msg, extra);
export const conflict = (msg: string, code = 'conflict', extra?: Record<string, unknown>) => new HttpError(409, code, msg, extra);

export function parseJsonArray<T = unknown>(s: string | null | undefined): T[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** ZIPエントリ・Content-Disposition 用にファイル名を安全化 */
export function safeFileName(name: string, fallback = 'file'): string {
  let n = name.normalize('NFC');
  n = n.replace(/[\u0000-\u001f\u007f]/g, '');
  n = n.replace(/[\\/:*?"<>|]/g, '_');
  n = n.replace(/^\.+/, '').trim();
  if (n === '' || n === '.' || n === '..') n = fallback;
  // 長すぎる名前は拡張子を保って切り詰め（UTF-8で200byte程度）
  if (Buffer.byteLength(n) > 200) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : '';
    let base = ext ? n.slice(0, dot) : n;
    while (Buffer.byteLength(base + ext) > 200) base = base.slice(0, -1);
    n = base + ext;
  }
  return n;
}

export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const safe = safeFileName(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export function hashIp(secret: string, ip: string | undefined): string {
  if (!ip) return '';
  return hmacHex(secret, `ip:${ip}`).slice(0, 16);
}

export function shortUa(ua: string | undefined): string {
  return (ua ?? '').slice(0, 180);
}

/**
 * 部分更新用スキーマ: .partial() は zod の default を適用してしまい、
 * 送っていない項目が既定値で上書きされるため、default を外してから optional にする。
 */
export function patchSchema<T extends z.ZodRawShape>(obj: z.ZodObject<T>): ReturnType<z.ZodObject<T>['partial']> {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(obj.shape)) {
    let t = v as z.ZodType;
    while (t instanceof z.ZodDefault) t = t.unwrap() as z.ZodType;
    shape[k] = t.optional();
  }
  return z.object(shape) as unknown as ReturnType<z.ZodObject<T>['partial']>;
}

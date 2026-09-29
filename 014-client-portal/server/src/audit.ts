import type { Actor } from './context.js';
import type { DB } from './db.js';
import { newId, nowIso, sha256Hex } from './util.js';

export interface AuditInput {
  ownerId: string | null;
  projectId?: string | null;
  actor: Actor;
  action: string;
  targetType?: string;
  targetId?: string;
  summary?: string;
  /** 秘密情報（トークン・パスワード・ファイル本文）を入れないこと */
  detail?: Record<string, unknown>;
  clientVisible?: boolean;
  ipHash?: string;
  userAgent?: string;
}

const FORBIDDEN_DETAIL_KEYS = /token|password|secret|cookie|authorization/i;

function sanitizeDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return '{}';
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (FORBIDDEN_DETAIL_KEYS.test(k)) continue;
    clean[k] = v;
  }
  return JSON.stringify(clean);
}

function rowHash(prev: string, r: Record<string, unknown>): string {
  return sha256Hex(
    [
      prev,
      r.id,
      r.owner_id ?? '',
      r.project_id ?? '',
      r.actor_type,
      r.actor_id,
      r.action,
      r.target_type,
      r.target_id,
      r.summary,
      r.detail_json,
      r.created_at,
    ].join('\u001f'),
  );
}

/** 監査ログ追記（ハッシュチェーン付き）。呼び出し側のトランザクション内で実行してよい */
export function audit(db: DB, input: AuditInput): string {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
  const prev = last?.hash ?? 'GENESIS';
  const row = {
    id: newId('aud'),
    owner_id: input.ownerId,
    project_id: input.projectId ?? null,
    actor_type: input.actor.type,
    actor_id: input.actor.id,
    actor_name: input.actor.name.slice(0, 120),
    action: input.action,
    target_type: input.targetType ?? '',
    target_id: input.targetId ?? '',
    client_visible: input.clientVisible ? 1 : 0,
    summary: (input.summary ?? '').slice(0, 300),
    detail_json: sanitizeDetail(input.detail),
    ip_hash: input.ipHash ?? '',
    user_agent: (input.userAgent ?? '').slice(0, 180),
    created_at: nowIso(),
    prev_hash: prev,
    hash: '',
  };
  row.hash = rowHash(prev, row);
  db.prepare(
    `INSERT INTO audit_log (id, owner_id, project_id, actor_type, actor_id, actor_name, action, target_type, target_id,
      client_visible, summary, detail_json, ip_hash, user_agent, created_at, prev_hash, hash)
     VALUES (@id, @owner_id, @project_id, @actor_type, @actor_id, @actor_name, @action, @target_type, @target_id,
      @client_visible, @summary, @detail_json, @ip_hash, @user_agent, @created_at, @prev_hash, @hash)`,
  ).run(row);
  return row.id;
}

/** ハッシュチェーン検証。改ざん・欠落があれば最初の不一致seqを返す */
export function verifyAuditChain(db: DB): { ok: boolean; checked: number; brokenAt?: number } {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').iterate() as IterableIterator<Record<string, unknown>>;
  let prev: string | null = null;
  let checked = 0;
  for (const r of rows) {
    const expectedPrev = prev ?? (r.prev_hash as string); // 先頭は保存値をアンカーとする（パージ後も検証可能）
    if (r.prev_hash !== expectedPrev || rowHash(expectedPrev, r) !== r.hash) {
      return { ok: false, checked, brokenAt: r.seq as number };
    }
    prev = r.hash as string;
    checked++;
  }
  return { ok: true, checked };
}

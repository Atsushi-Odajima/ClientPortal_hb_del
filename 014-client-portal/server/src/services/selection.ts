/**
 * Client Portal 写真セレクト
 * 運営者が写真をまとめて「セレクト」に登録すると 001, 002… の番号が付き、顧客はポータルで
 * クリックまたは番号入力（例「001, 007、012」）で選んで送信する。運営者は番号→元ファイル名の対応で結果を確認し、CSV/テキストで書き出す。
 * 番号付け・番号の読み取り・CSVの規則は shared/photoSelect.ts（元ツール「写真セレクト一覧メーカー」の移植）。
 */
import type { Actor, ClientRow, Ctx, FileRow, ProjectRow } from '../context.js';
import type { DB } from '../db.js';
import { audit } from '../audit.js';
import { notify, notifyProjectClients } from '../notify.js';
import { badRequest, conflict, newId, notFound, nowIso } from '../util.js';
import { fileDto } from './dto.js';
import { SELECTION_MAX_PHOTOS, buildCsv, buildSelectionText, checkSelection, formatNumber, naturalCompare } from '../../../shared/photoSelect.js';

export interface SelectionSetRow {
  id: string;
  project_id: string;
  title: string;
  message: string;
  show_names: number;
  status: 'draft' | 'open' | 'closed';
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PhotoJoinRow extends FileRow {
  photo_id: string;
  position: number;
}

interface ResponseRow {
  set_id: string;
  client_id: string;
  client_name: string;
  note: string;
  picks_updated_at: string | null;
  submitted_at: string | null;
  submitted_count: number;
}

interface Meta {
  ipHash: string;
  userAgent: string;
}

const STATUS_LABEL: Record<SelectionSetRow['status'], string> = { draft: '準備中（お客様に非表示）', open: '選択受付中', closed: '受付終了' };

// ---- 取得・認可 ----

/** 運営者: 自分の案件（呼び出し側で ownedProject 済み）のセット */
export function projectSelection(db: DB, projectId: string, setId: string): SelectionSetRow {
  const s = db.prepare('SELECT * FROM selection_sets WHERE id = ? AND project_id = ?').get(setId, projectId) as SelectionSetRow | undefined;
  if (!s) throw notFound('写真セレクト');
  return s;
}

/** 顧客: 公開済み（open/closed）のセットのみ。準備中は存在を明かさない */
export function clientSelection(db: DB, projectId: string, setId: string): SelectionSetRow {
  const s = projectSelection(db, projectId, setId);
  if (s.status === 'draft') throw notFound('写真セレクト');
  return s;
}

function photos(db: DB, setId: string): PhotoJoinRow[] {
  return db
    .prepare(
      `SELECT f.*, sp.id photo_id, sp.position FROM selection_photos sp JOIN files f ON f.id = sp.file_id
       WHERE sp.set_id = ? ORDER BY sp.position`,
    )
    .all(setId) as PhotoJoinRow[];
}

function picksOf(db: DB, setId: string, clientId?: string): { client_id: string; photo_id: string }[] {
  return clientId
    ? (db.prepare('SELECT client_id, photo_id FROM selection_picks WHERE set_id = ? AND client_id = ?').all(setId, clientId) as { client_id: string; photo_id: string }[])
    : (db.prepare('SELECT client_id, photo_id FROM selection_picks WHERE set_id = ?').all(setId) as { client_id: string; photo_id: string }[]);
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? `.${m[1].toLowerCase()}` : '';
}

/** 顧客向けの表示名: 元ファイル名を見せない設定なら「007.jpg」 */
export function selectionDisplayName(db: DB, f: FileRow): string {
  const r = db
    .prepare(`SELECT sp.position, s.show_names FROM selection_photos sp JOIN selection_sets s ON s.id = sp.set_id WHERE sp.file_id = ?`)
    .get(f.id) as { position: number; show_names: number } | undefined;
  if (!r || r.show_names) return f.original_name;
  return `${formatNumber(r.position)}${extOf(f.original_name)}`;
}

// ---- アップロード連携（routes/files.ts から呼ばれる） ----

export function assertSelectionAcceptsPhoto(db: DB, projectId: string, setId: string): void {
  const s = projectSelection(db, projectId, setId);
  if (s.status === 'closed') throw conflict('受付終了したセレクトには写真を追加できません。受付を再開してください', 'selection_closed');
  const n = (db.prepare('SELECT COUNT(*) n FROM selection_photos WHERE set_id = ?').get(setId) as { n: number }).n;
  if (n >= SELECTION_MAX_PHOTOS) throw badRequest(`1つのセレクトに登録できる写真は${SELECTION_MAX_PHOTOS}枚までです。セレクトを分けて作成してください`, 'selection_full');
}

/** 末尾に追加（公開後に追加しても既存の番号は変わらない）。呼び出し側トランザクション内 */
export function addSelectionPhoto(db: DB, projectId: string, setId: string, fileId: string): { photoId: string; number: number } {
  assertSelectionAcceptsPhoto(db, projectId, setId);
  const max = (db.prepare('SELECT COALESCE(MAX(position), 0) m FROM selection_photos WHERE set_id = ?').get(setId) as { m: number }).m;
  const id = newId('sph');
  db.prepare('INSERT INTO selection_photos (id, set_id, project_id, file_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, setId, projectId, fileId, max + 1, nowIso());
  db.prepare('UPDATE selection_sets SET updated_at = ? WHERE id = ?').run(nowIso(), setId);
  return { photoId: id, number: max + 1 };
}

// ---- DTO ----

export function selectionSummaryDto(db: DB, s: SelectionSetRow, audience: 'operator' | 'client', clientId?: string) {
  const count = (db.prepare('SELECT COUNT(*) n FROM selection_photos WHERE set_id = ?').get(s.id) as { n: number }).n;
  const base = { id: s.id, title: s.title, message: s.message, status: s.status, statusLabel: STATUS_LABEL[s.status], photoCount: count, updatedAt: s.updated_at };
  if (audience === 'client') {
    const mine = picksOf(db, s.id, clientId).length;
    const r = db.prepare('SELECT * FROM selection_responses WHERE set_id = ? AND client_id = ?').get(s.id, clientId) as ResponseRow | undefined;
    return { ...base, myPickCount: mine, submittedAt: r?.submitted_at ?? null };
  }
  const responses = db.prepare('SELECT * FROM selection_responses WHERE set_id = ? AND submitted_at IS NOT NULL').all(s.id) as ResponseRow[];
  return {
    ...base,
    showNames: !!s.show_names,
    openedAt: s.opened_at,
    closedAt: s.closed_at,
    submittedCount: responses.length,
    lastSubmittedAt: responses.map((r) => r.submitted_at!).sort().pop() ?? null,
  };
}

export function selectionDetailForOperator(db: DB, p: ProjectRow, s: SelectionSetRow) {
  const list = photos(db, s.id);
  const nameCount = new Map<string, number>();
  for (const f of list) nameCount.set(f.original_name, (nameCount.get(f.original_name) ?? 0) + 1);
  const picks = picksOf(db, s.id);
  const responses = db.prepare('SELECT * FROM selection_responses WHERE set_id = ? ORDER BY submitted_at').all(s.id) as ResponseRow[];
  const byPhoto = new Map<string, string[]>();
  for (const pk of picks) byPhoto.set(pk.photo_id, [...(byPhoto.get(pk.photo_id) ?? []), pk.client_id]);
  const photoById = new Map(list.map((f) => [f.photo_id, f]));
  return {
    set: selectionSummaryDto(db, s, 'operator'),
    photos: list.map((f) => ({
      id: f.photo_id,
      number: formatNumber(f.position),
      position: f.position,
      name: f.original_name,
      sameName: (nameCount.get(f.original_name) ?? 0) > 1,
      pickedBy: byPhoto.get(f.photo_id) ?? [],
      file: fileDto(f, 'operator'),
    })),
    responses: responses.map((r) => {
      const mine = picks
        .filter((pk) => pk.client_id === r.client_id)
        .map((pk) => photoById.get(pk.photo_id)!)
        .filter(Boolean)
        .sort((a, b) => a.position - b.position);
      return {
        clientId: r.client_id,
        clientName: r.client_name,
        note: r.note,
        submittedAt: r.submitted_at,
        picksUpdatedAt: r.picks_updated_at,
        /** 送信後に選択が変更され、まだ送信されていない */
        changedAfterSubmit: !!r.submitted_at && !!r.picks_updated_at && r.picks_updated_at > r.submitted_at,
        picks: mine.map((f) => ({ photoId: f.photo_id, number: formatNumber(f.position), name: f.original_name })),
      };
    }),
    projectName: p.name,
  };
}

export function selectionDetailForClient(db: DB, s: SelectionSetRow, c: ClientRow) {
  const list = photos(db, s.id);
  const mine = new Set(picksOf(db, s.id, c.id).map((r) => r.photo_id));
  const r = db.prepare('SELECT * FROM selection_responses WHERE set_id = ? AND client_id = ?').get(s.id, c.id) as ResponseRow | undefined;
  return {
    set: { ...selectionSummaryDto(db, s, 'client', c.id), showNames: !!s.show_names },
    photos: list.map((f) => {
      const dto = fileDto(f, 'client');
      return {
        id: f.photo_id,
        number: formatNumber(f.position),
        // 元ファイル名を見せない設定ならファイル名を返さない
        name: s.show_names ? f.original_name : null,
        width: f.width,
        height: f.height,
        url: dto.url,
        downloadUrl: dto.downloadUrl,
        picked: mine.has(f.photo_id),
      };
    }),
    myResponse: {
      note: r?.note ?? '',
      submittedAt: r?.submitted_at ?? null,
      picksUpdatedAt: r?.picks_updated_at ?? null,
      changedAfterSubmit: !!r?.submitted_at && !!r?.picks_updated_at && r.picks_updated_at > r.submitted_at,
    },
  };
}

// ---- 運営者の操作 ----

export function createSelection(ctx: Ctx, p: ProjectRow, actor: Actor, input: { title: string; message: string; showNames: boolean }, meta: Meta) {
  const id = newId('sel');
  const now = nowIso();
  ctx.db.transaction(() => {
    ctx.db
      .prepare('INSERT INTO selection_sets (id, project_id, title, message, show_names, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.id, input.title, input.message, input.showNames ? 1 : 0, 'draft', now, now);
    audit(ctx.db, { ownerId: p.owner_id, projectId: p.id, actor, action: 'selection.created', targetType: 'selection', targetId: id, summary: `写真セレクト「${input.title}」を作成`, ...meta });
  })();
  return { id };
}

export function updateSelection(ctx: Ctx, s: SelectionSetRow, input: { title?: string; message?: string; showNames?: boolean }) {
  ctx.db
    .prepare('UPDATE selection_sets SET title = ?, message = ?, show_names = ?, updated_at = ? WHERE id = ?')
    .run(input.title ?? s.title, input.message ?? s.message, input.showNames === undefined ? s.show_names : input.showNames ? 1 : 0, nowIso(), s.id);
}

export function setSelectionStatus(ctx: Ctx, p: ProjectRow, s: SelectionSetRow, to: 'open' | 'closed', actor: Actor, meta: Meta) {
  const { db } = ctx;
  if (to === 'open') {
    if (s.status === 'open') return;
    const n = (db.prepare('SELECT COUNT(*) n FROM selection_photos WHERE set_id = ?').get(s.id) as { n: number }).n;
    if (n === 0) throw badRequest('写真を1枚以上追加してから公開してください');
  } else if (s.status !== 'open') throw conflict('受付中のセレクトのみ終了できます');
  const now = nowIso();
  db.transaction(() => {
    if (to === 'open') db.prepare(`UPDATE selection_sets SET status = 'open', opened_at = COALESCE(opened_at, ?), closed_at = NULL, updated_at = ? WHERE id = ?`).run(now, now, s.id);
    else db.prepare(`UPDATE selection_sets SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, s.id);
    audit(db, {
      ownerId: p.owner_id,
      projectId: p.id,
      actor,
      action: to === 'open' ? (s.status === 'draft' ? 'selection.opened' : 'selection.reopened') : 'selection.closed',
      targetType: 'selection',
      targetId: s.id,
      summary: to === 'open' ? `写真セレクト「${s.title}」の選択受付を開始` : `写真セレクト「${s.title}」の受付を終了`,
      clientVisible: true,
      ...meta,
    });
    if (to === 'open') {
      notifyProjectClients(ctx, p.id, {
        ownerId: p.owner_id,
        kind: 'selection_opened',
        title: `写真を選んでください: ${s.title}`,
        body: s.message.slice(0, 200),
        link: `/portal/p/${p.id}/select/${s.id}`,
        dedupeKey: `selopen:${s.id}:${now}`,
      });
    }
  })();
}

function assertDraft(s: SelectionSetRow) {
  // 顧客に番号を伝えた後に番号が変わらないよう、並べ替え・削除は公開前（準備中）のみ
  if (s.status !== 'draft') throw conflict('公開後は番号が変わる操作（並べ替え・削除）はできません。追加した写真は末尾の番号になります', 'numbers_locked');
}

/** 番号を 1..N に詰め直す（UNIQUE(set_id, position) を一時的に避けるため負数を経由） */
function renumber(db: DB, setId: string, orderedPhotoIds: string[]) {
  const upd = db.prepare('UPDATE selection_photos SET position = ? WHERE id = ? AND set_id = ?');
  orderedPhotoIds.forEach((id, i) => upd.run(-(i + 1), id, setId));
  orderedPhotoIds.forEach((id, i) => upd.run(i + 1, id, setId));
  db.prepare('UPDATE selection_sets SET updated_at = ? WHERE id = ?').run(nowIso(), setId);
}

export function movePhoto(ctx: Ctx, s: SelectionSetRow, photoId: string, toNumber: number) {
  assertDraft(s);
  const ids = (ctx.db.prepare('SELECT id FROM selection_photos WHERE set_id = ? ORDER BY position').all(s.id) as { id: string }[]).map((r) => r.id);
  const from = ids.indexOf(photoId);
  if (from < 0) throw notFound('写真');
  const to = Math.min(ids.length - 1, Math.max(0, Math.trunc(toNumber) - 1));
  ids.splice(from, 1);
  ids.splice(to, 0, photoId);
  ctx.db.transaction(() => renumber(ctx.db, s.id, ids))();
}

export function sortPhotosByName(ctx: Ctx, s: SelectionSetRow) {
  assertDraft(s);
  const list = photos(ctx.db, s.id);
  // 元ツールと同じ自然順（同名は登録順を保つ）
  const ids = [...list].sort((a, b) => naturalCompare(a.original_name, b.original_name) || a.position - b.position).map((f) => f.photo_id);
  ctx.db.transaction(() => renumber(ctx.db, s.id, ids))();
}

/** 準備中の写真を削除（顧客に一度も公開していないため、ファイル実体も削除する） */
export async function deletePhotos(ctx: Ctx, p: ProjectRow, s: SelectionSetRow, photoIds: string[] | 'all', actor: Actor, meta: Meta) {
  assertDraft(s);
  const { db } = ctx;
  const all = photos(db, s.id);
  const targets = photoIds === 'all' ? all : all.filter((f) => photoIds.includes(f.photo_id));
  if (photoIds !== 'all' && targets.length !== photoIds.length) throw notFound('写真');
  const keys = targets.map((f) => f.storage_key);
  db.transaction(() => {
    for (const f of targets) {
      db.prepare('DELETE FROM selection_photos WHERE id = ?').run(f.photo_id);
      db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    }
    const rest = (db.prepare('SELECT id FROM selection_photos WHERE set_id = ? ORDER BY position').all(s.id) as { id: string }[]).map((r) => r.id);
    renumber(db, s.id, rest);
    audit(db, {
      ownerId: p.owner_id,
      projectId: p.id,
      actor,
      action: 'selection.photos_deleted',
      targetType: 'selection',
      targetId: s.id,
      summary: `写真セレクト「${s.title}」から写真${targets.length}枚を削除`,
      detail: { count: targets.length },
      ...meta,
    });
  })();
  for (const k of keys) await ctx.storage.delete(k).catch(() => undefined);
}

export async function deleteSelection(ctx: Ctx, p: ProjectRow, s: SelectionSetRow, actor: Actor, meta: Meta) {
  if (s.status !== 'draft') throw conflict('公開したセレクトは履歴のため削除できません（受付終了にしてください）', 'not_draft');
  await deletePhotos(ctx, p, s, 'all', actor, meta);
  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM selection_sets WHERE id = ?').run(s.id);
    audit(ctx.db, { ownerId: p.owner_id, projectId: p.id, actor, action: 'selection.deleted', targetType: 'selection', targetId: s.id, summary: `写真セレクト「${s.title}」を削除`, ...meta });
  })();
}

/** 書き出し: map=番号対応表（全写真）, picks=選択結果。format=csv（BOM+CRLF）/ txt（BOM+CRLF） */
export function exportSelection(db: DB, s: SelectionSetRow, kind: 'map' | 'picks', format: 'csv' | 'txt', clientId?: string): { body: string; filename: string } {
  const list = photos(db, s.id);
  const base = `写真セレクト_${s.title}`;
  if (kind === 'map') {
    if (format === 'csv') return { body: buildCsv(list.map((f) => f.original_name), list.map((f) => f.position)), filename: `${base}_番号対応表.csv` };
    return { body: '﻿' + list.map((f) => `${formatNumber(f.position)} → ${f.original_name}`).join('\r\n') + '\r\n', filename: `${base}_番号対応表.txt` };
  }
  const byId = new Map(list.map((f) => [f.photo_id, f]));
  const responses = (db.prepare('SELECT * FROM selection_responses WHERE set_id = ? ORDER BY submitted_at').all(s.id) as ResponseRow[]).filter(
    (r) => !clientId || r.client_id === clientId,
  );
  const picks = picksOf(db, s.id, clientId);
  const picked = [...new Set(picks.map((p) => p.photo_id))]
    .map((id) => byId.get(id)!)
    .filter(Boolean)
    .sort((a, b) => a.position - b.position);
  if (format === 'csv') return { body: buildCsv(picked.map((f) => f.original_name), picked.map((f) => f.position)), filename: `${base}_選択結果.csv` };
  const parts = (responses.length ? responses : [null]).map((r) => {
    const mine = r ? picks.filter((p) => p.client_id === r.client_id).map((p) => byId.get(p.photo_id)!).filter(Boolean).sort((a, b) => a.position - b.position) : picked;
    return buildSelectionText(
      { title: s.title, clientName: r?.client_name, submittedAt: r?.submitted_at ?? null, note: r?.note },
      mine.map((f) => ({ number: f.position, name: f.original_name })),
      '\r\n',
    );
  });
  return { body: '﻿' + parts.join('\r\n\r\n----------------------------------------\r\n\r\n') + '\r\n', filename: `${base}_選択結果.txt` };
}

// ---- 顧客の操作 ----

function upsertResponse(db: DB, s: SelectionSetRow, c: ClientRow, patch: { picksUpdatedAt?: string; submittedAt?: string; note?: string; submittedCount?: number }) {
  const name = c.contact_name || c.company_name;
  db.prepare(
    `INSERT INTO selection_responses (set_id, client_id, client_name, note, picks_updated_at, submitted_at, submitted_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(set_id, client_id) DO UPDATE SET client_name = excluded.client_name,
       note = COALESCE(?, note),
       picks_updated_at = COALESCE(?, picks_updated_at),
       submitted_at = COALESCE(?, submitted_at),
       submitted_count = COALESCE(?, submitted_count)`,
  ).run(
    s.id,
    c.id,
    name,
    patch.note ?? '',
    patch.picksUpdatedAt ?? null,
    patch.submittedAt ?? null,
    patch.submittedCount ?? 0,
    patch.note ?? null,
    patch.picksUpdatedAt ?? null,
    patch.submittedAt ?? null,
    patch.submittedCount ?? null,
  );
}

function assertOpen(s: SelectionSetRow) {
  if (s.status !== 'open') throw conflict('このセレクトは受付を終了しています。変更が必要な場合は担当者にご連絡ください', 'selection_closed');
}

/**
 * 選択の保存。
 * - photoIds: 選択を丸ごと置き換え（クリック選択）
 * - numbersText: 「001, 007、012」形式の番号入力。mode=add は現在の選択に追加、replace は置き換え。
 *   見つからない番号・読めない語は選択に加えず、結果（checkSelection の内容）を返す
 */
export function savePicks(ctx: Ctx, s: SelectionSetRow, c: ClientRow, input: { photoIds?: string[]; numbersText?: string; mode?: 'add' | 'replace' }) {
  const { db } = ctx;
  assertOpen(s);
  const list = photos(db, s.id);
  const valid = new Set(list.map((f) => f.photo_id));
  let next: Set<string>;
  let check: ReturnType<typeof checkSelection> | null = null;
  if (input.numbersText !== undefined) {
    // 番号 n は position n（公開後は詰め直さないため、欠番なく 1..N）
    const names = list.map((f) => (s.show_names ? f.original_name : formatNumber(f.position)));
    check = checkSelection(input.numbersText, names);
    const byPos = new Map(list.map((f) => [f.position, f.photo_id]));
    const ids = check.results.filter((r) => r.found && byPos.has(r.number)).map((r) => byPos.get(r.number)!);
    next = input.mode === 'replace' ? new Set(ids) : new Set([...picksOf(db, s.id, c.id).map((r) => r.photo_id), ...ids]);
  } else {
    const ids = input.photoIds ?? [];
    // 他のセット・他の案件の写真IDは存在を明かさず拒否
    for (const id of ids) if (!valid.has(id)) throw notFound('写真');
    next = new Set(ids);
  }
  const now = nowIso();
  db.transaction(() => {
    db.prepare('DELETE FROM selection_picks WHERE set_id = ? AND client_id = ?').run(s.id, c.id);
    const ins = db.prepare('INSERT INTO selection_picks (set_id, client_id, photo_id, created_at) VALUES (?, ?, ?, ?)');
    for (const id of next) ins.run(s.id, c.id, id, now);
    upsertResponse(db, s, c, { picksUpdatedAt: now });
  })();
  return { pickedIds: [...next], check };
}

export function submitPicks(ctx: Ctx, p: ProjectRow, s: SelectionSetRow, c: ClientRow, note: string, meta: Meta) {
  const { db } = ctx;
  assertOpen(s);
  const list = photos(db, s.id);
  const mine = new Set(picksOf(db, s.id, c.id).map((r) => r.photo_id));
  const picked = list.filter((f) => mine.has(f.photo_id));
  if (picked.length === 0) throw badRequest('写真を1枚以上選んでください');
  const name = c.contact_name || c.company_name;
  const now = nowIso();
  const labels = picked.map((f) => formatNumber(f.position));
  db.transaction(() => {
    upsertResponse(db, s, c, { submittedAt: now, note: note.trim().slice(0, 2000), submittedCount: picked.length });
    db.prepare('UPDATE selection_sets SET updated_at = ? WHERE id = ?').run(now, s.id);
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, p.id);
    audit(db, {
      ownerId: p.owner_id,
      projectId: p.id,
      actor: { type: 'client', id: c.id, name },
      action: 'selection.submitted',
      targetType: 'selection',
      targetId: s.id,
      summary: `写真セレクト「${s.title}」で${picked.length}枚を選択して送信`,
      detail: { count: picked.length, numbers: labels.slice(0, 300) },
      clientVisible: true,
      ...meta,
    });
    notify(ctx, {
      ownerId: p.owner_id,
      recipientType: 'operator',
      recipientId: p.owner_id,
      projectId: p.id,
      kind: 'selection_submitted',
      title: `写真が選ばれました: ${s.title}（${name}・${picked.length}枚）`,
      body: labels.join(', ').slice(0, 300),
      link: `/app/projects/${p.id}/selections/${s.id}`,
      dedupeKey: `selsub:${s.id}:${c.id}:${now}`,
    });
  })();
  return { submittedAt: now, count: picked.length };
}

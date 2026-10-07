/**
 * Client Portal 写真セレクト — 番号付け・返信番号の読み取り・CSV生成。
 * 元ツール「写真セレクト一覧メーカー」(js/util.js, js/selection.js) の規則をそのまま移植している。
 * サーバー・画面の両方から使う（DOM非依存）。
 */

/** 番号の表示形式（3桁ゼロ埋め。999を超える場合は必要な桁数に伸ばす） */
export function formatNumber(n: number): string {
  let s = String(n);
  while (s.length < 3) s = '0' + s;
  return s;
}

/** ファイル名の自然順（IMG_2 → IMG_10）。元ツールの naturalCompare と同じ */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' });
}

/** 区切り: 半角/全角カンマ、読点（、､）、半角/全角空白、タブ、改行 */
const SEPARATORS = /[,，、､\s　]+/;

function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

export interface SelectionCheckItem {
  /** 入力されたままの語 */
  input: string;
  number: number;
  /** 3桁表示（例 007） */
  label: string;
  /** 対応する元ファイル名（一覧にない番号は null） */
  name: string | null;
  found: boolean;
}

export interface SelectionCheckResult {
  results: SelectionCheckItem[];
  duplicates: { label: string; count: number }[];
  /** 数字以外を含むため番号として読めなかった語（推測で補正しない） */
  invalid: string[];
  empty: boolean;
}

/**
 * 「001, 007、012」のような返信文から番号を取り出し、元ファイル名と照合する。
 * names: 番号順の元ファイル名（index 0 = 001）
 * - 一覧にない番号は「該当なし」（近い番号に置き換えない）
 * - 「7」は 007 として照合（input に元の表記を残す）
 * - 重複は1件にまとめ、duplicates で知らせる
 */
export function checkSelection(text: string | null | undefined, names: readonly string[]): SelectionCheckResult {
  const tokens = String(text ?? '')
    .split(SEPARATORS)
    .filter((t) => t !== '');
  const results: SelectionCheckItem[] = [];
  const invalid: string[] = [];
  const seen: Record<string, boolean> = {};
  const dupCount: Record<string, number> = {};
  for (const raw of tokens) {
    const t = toHalfWidthDigits(raw);
    if (!/^\d+$/.test(t)) {
      invalid.push(raw);
      continue;
    }
    const n = parseInt(t, 10);
    const key = String(n);
    if (seen[key]) {
      dupCount[key] = (dupCount[key] || 1) + 1;
      continue;
    }
    seen[key] = true;
    const found = n >= 1 && n <= names.length;
    results.push({ input: raw, number: n, label: formatNumber(n), name: found ? names[n - 1] : null, found });
  }
  const duplicates = Object.keys(dupCount).map((k) => ({ label: formatNumber(Number(k)), count: dupCount[k] }));
  return { results, duplicates, invalid, empty: tokens.length === 0 };
}

/** CSV1項目（区切り・改行・引用符は引用符で囲む。数式として解釈されうる先頭文字には ' を付ける） */
export function csvField(value: unknown): string {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 番号対応表CSV（UTF-8 BOM付き、CRLF改行）。rows を省略すると names の並びで 001〜 を付ける */
export function buildCsv(names: readonly string[], numbers?: readonly number[]): string {
  const lines = ['番号,元ファイル名'];
  for (let i = 0; i < names.length; i++) lines.push(formatNumber(numbers ? numbers[i] : i + 1) + ',' + csvField(names[i]));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** 選択結果テキスト（「001 → IMG_5832.jpg」形式。元ツールの選択番号確認の表示と同じ） */
export function buildSelectionText(
  header: { title?: string; clientName?: string; submittedAt?: string | null; note?: string },
  picks: readonly { number: number; name: string }[],
  eol = '\n',
): string {
  const L: string[] = [];
  if (header.title) L.push('セレクト名：' + header.title);
  if (header.clientName) L.push('選んだ人：' + header.clientName);
  if (header.submittedAt) L.push('送信日時：' + header.submittedAt);
  L.push('選択枚数：' + picks.length + '枚');
  L.push('');
  if (picks.length === 0) L.push('（選択なし）');
  for (const p of picks) L.push(formatNumber(p.number) + ' → ' + p.name);
  if (header.note) {
    L.push('');
    L.push('【コメント】');
    L.push(header.note);
  }
  return L.join('\n').replace(/\r\n?/g, '\n').split('\n').join(eol);
}

/** 1セットに含められる写真の上限（元ツールの MAX_COUNT）と、確認を出す目安（WARN_COUNT） */
export const SELECTION_MAX_PHOTOS = 300;
export const SELECTION_WARN_PHOTOS = 150;

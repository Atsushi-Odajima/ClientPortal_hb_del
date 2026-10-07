/**
 * Client Portal 修正指示 — 画像ピンの指示タイプと修正指示書テキスト。
 * 元ツール「画像 修正指示メーカー」(assets/app.js の TYPES / circled / buildText) の規則を移植している。
 * サーバー・画面の両方から使う（DOM非依存）。
 */

export const PIN_TYPES = [
  { id: 'change', label: '変更' },
  { id: 'delete', label: '削除' },
  { id: 'add', label: '追加' },
  { id: 'move', label: '移動' },
  { id: 'keep', label: '変更しない' },
  { id: 'other', label: 'その他' },
] as const;

export type PinType = (typeof PIN_TYPES)[number]['id'];
export const PIN_TYPE_IDS = PIN_TYPES.map((t) => t.id) as [PinType, ...PinType[]];
export const PIN_TYPE_LABEL: Record<PinType, string> = Object.fromEntries(PIN_TYPES.map((t) => [t.id, t.label])) as Record<PinType, string>;

/** 定型文（押すと入力欄に追記し、指示タイプも合わせる） */
export const PIN_PRESETS: { text: string; type: PinType }[] = [
  { text: '削除してください', type: 'delete' },
  { text: '少し大きくしてください', type: 'change' },
  { text: '少し小さくしてください', type: 'change' },
  { text: '右へ移動してください', type: 'move' },
  { text: '左へ移動してください', type: 'move' },
  { text: '上へ移動してください', type: 'move' },
  { text: '下へ移動してください', type: 'move' },
  { text: '色を変更してください', type: 'change' },
  { text: 'ここは変更しないでください', type: 'keep' },
];

/** 定型文の追記（元ツールの applyPreset と同じ: 「ください」で終わっていたら句点を補い、定型文＋「。」を続ける） */
export function applyPreset(current: string, presetText: string): string {
  let cur = current;
  if (/ください$/.test(cur)) cur += '。';
  return cur + presetText + '。';
}

/** マーカー色（修正=赤丸、変更しない=青の角丸四角。色だけに依存しないよう形も変える） */
export const MARKER_COLOR_FIX = '#d93025';
export const MARKER_COLOR_KEEP = '#1d6fd8';

/** ①〜⑳、21以降は (21) */
export function circled(n: number): string {
  if (n >= 1 && n <= 20) return String.fromCharCode(0x245f + n);
  return '(' + n + ')';
}

export function normalizePinType(t: string | null | undefined): PinType {
  return (PIN_TYPE_IDS as string[]).includes(t ?? '') ? (t as PinType) : 'change';
}

export interface SheetPin {
  /** ピン番号（Client Portal ではピン作成時に確定し、削除しても振り直さない） */
  number: number;
  type: PinType;
  text: string;
  resolved?: boolean;
}

export interface SheetInfo {
  projectName?: string;
  imageName?: string;
  /** YYYY-MM-DD または YYYY/MM/DD */
  date?: string;
  note?: string;
}

export function splitPins<T extends SheetPin>(pins: readonly T[]): { fix: T[]; keep: T[] } {
  const sorted = [...pins].sort((a, b) => a.number - b.number);
  return { fix: sorted.filter((p) => p.type !== 'keep'), keep: sorted.filter((p) => p.type === 'keep') };
}

/**
 * 修正指示テキスト。構成は元ツールと同じ:
 * 案件名 / 画像名 / 作成日 → 注記 → 【修正指示】（keep以外, 番号順）→【変更しない箇所】→【備考】
 * eol: 画面・コピーは '\n'、.txt 保存は '\r\n'（+ BOM は呼び出し側）
 */
export function buildInstructionText(info: SheetInfo, pins: readonly SheetPin[], eol = '\n'): string {
  const L: string[] = [];
  const sp = splitPins(pins);
  if (info.projectName) L.push('案件名：' + info.projectName);
  if (info.imageName) L.push('画像名：' + info.imageName);
  if (info.date) L.push('作成日：' + info.date.replace(/-/g, '/'));
  if (L.length) L.push('');

  L.push('※ 画像内の番号と、下記の番号が対応しています。');
  if (sp.keep.length) L.push('※ 青い四角の番号は「変更しない箇所」です。');
  L.push('');

  L.push('【修正指示】');
  L.push('');
  if (!sp.fix.length) {
    L.push('（なし）');
    L.push('');
  }
  for (const p of sp.fix) {
    L.push(circled(p.number) + ' [' + PIN_TYPE_LABEL[p.type] + ']' + (p.resolved ? '（対応済み）' : ''));
    L.push(p.text.trim() || '（内容未入力）');
    L.push('');
  }
  if (sp.keep.length) {
    L.push('【変更しない箇所】');
    L.push('');
    for (const p of sp.keep) {
      L.push(circled(p.number));
      L.push(p.text.trim() || '（内容未入力：この箇所は変更しないでください）');
      L.push('');
    }
  }
  if (info.note && info.note.trim()) {
    L.push('【備考】');
    L.push('');
    L.push(info.note.trim());
    L.push('');
  }
  while (L.length && L[L.length - 1] === '') L.pop();
  return L.join('\n').replace(/\r\n?/g, '\n').split('\n').join(eol);
}

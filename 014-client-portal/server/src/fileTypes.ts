import fs from 'node:fs/promises';
import { fileTypeFromFile } from 'file-type';

/**
 * アップロードファイルの種類判定ポリシー。
 * - 実行ファイル・スクリプト・HTMLは拒否
 * - 既知拡張子は実体（マジックバイト）との一致を検証
 * - 配信時の Content-Type は実体判定結果から決定し、クライアント申告値は信用しない
 */

export const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'com', 'bat', 'cmd', 'msi', 'msp', 'scr', 'pif', 'cpl', 'vbs', 'vbe', 'js', 'mjs', 'cjs', 'jse',
  'wsf', 'wsh', 'ps1', 'psm1', 'sh', 'bash', 'csh', 'ksh', 'zsh', 'jar', 'apk', 'ipa', 'app', 'deb', 'rpm', 'dmg',
  'pkg', 'lnk', 'reg', 'hta', 'msc', 'gadget', 'php', 'phtml', 'cgi', 'pl', 'py', 'rb', 'asp', 'aspx', 'jsp',
  'html', 'htm', 'xhtml', 'shtml', 'mht', 'mhtml', 'xht', 'svgz', 'desktop', 'command', 'scpt', 'workflow',
]);

/** 実体判定で検出されたら拡張子に関わらず拒否する形式 */
const BLOCKED_SNIFF_EXT = new Set(['exe', 'elf', 'mach', 'class', 'wasm', 'dmg', 'apk', 'deb', 'rpm', 'msi', 'lnk', 'dex', 'ipa']);

interface TypeRule {
  /** 実体判定で許容する file-type の ext */
  sniff: string[];
  /** 実体判定できない（テキスト系）場合に許容するか */
  allowUndetected: boolean;
  mime: string;
}

const R = (sniff: string[], mime: string, allowUndetected = false): TypeRule => ({ sniff, mime, allowUndetected });

const RULES: Record<string, TypeRule> = {
  jpg: R(['jpg'], 'image/jpeg'),
  jpeg: R(['jpg'], 'image/jpeg'),
  png: R(['png', 'apng'], 'image/png'),
  gif: R(['gif'], 'image/gif'),
  webp: R(['webp'], 'image/webp'),
  avif: R(['avif'], 'image/avif'),
  heic: R(['heic', 'heif', 'avif'], 'image/heic'),
  heif: R(['heic', 'heif', 'avif'], 'image/heif'),
  tif: R(['tif'], 'image/tiff'),
  tiff: R(['tif'], 'image/tiff'),
  bmp: R(['bmp'], 'image/bmp'),
  psd: R(['psd'], 'image/vnd.adobe.photoshop'),
  pdf: R(['pdf'], 'application/pdf'),
  ai: R(['pdf', 'ai', 'eps', 'ps'], 'application/postscript', true),
  eps: R(['eps', 'ps', 'pdf'], 'application/postscript', true),
  mp4: R(['mp4', 'm4v', 'mov', 'm4a'], 'video/mp4'),
  m4v: R(['mp4', 'm4v', 'mov'], 'video/x-m4v'),
  mov: R(['mov', 'mp4', 'qt'], 'video/quicktime'),
  webm: R(['webm'], 'video/webm'),
  avi: R(['avi'], 'video/x-msvideo'),
  mkv: R(['mkv'], 'video/x-matroska'),
  mp3: R(['mp3'], 'audio/mpeg'),
  wav: R(['wav'], 'audio/wav'),
  m4a: R(['m4a', 'mp4'], 'audio/mp4'),
  aac: R(['aac', 'm4a'], 'audio/aac'),
  docx: R(['docx', 'zip'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  xlsx: R(['xlsx', 'zip'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  pptx: R(['pptx', 'zip'], 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  doc: R(['cfb', 'doc'], 'application/msword'),
  xls: R(['cfb', 'xls'], 'application/vnd.ms-excel'),
  ppt: R(['cfb', 'ppt'], 'application/vnd.ms-powerpoint'),
  zip: R(['zip'], 'application/zip'),
  '7z': R(['7z'], 'application/x-7z-compressed'),
  rar: R(['rar'], 'application/vnd.rar'),
  ttf: R(['ttf'], 'font/ttf'),
  otf: R(['otf'], 'font/otf'),
  woff: R(['woff'], 'font/woff'),
  woff2: R(['woff2'], 'font/woff2'),
  txt: R([], 'text/plain; charset=utf-8', true),
  csv: R([], 'text/csv; charset=utf-8', true),
  md: R([], 'text/markdown; charset=utf-8', true),
  json: R([], 'application/json', true),
  svg: R(['svg', 'xml'], 'image/svg+xml', true),
  xml: R(['xml'], 'application/xml', true),
};

/** ブラウザ内プレビューを許可する（同一オリジンで安全に表示できる）形式 */
const PREVIEW_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const PREVIEW_VIDEO = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']);

export type PreviewKind = 'image' | 'pdf' | 'video' | 'none';

export interface FileCheckResult {
  ok: true;
  mime: string;
  ext: string;
  previewKind: PreviewKind;
  width?: number;
  height?: number;
}

export interface FileCheckError {
  ok: false;
  code: string;
  message: string;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** 事前チェック（名前とサイズのみ）: アップロード開始時 */
export function precheck(name: string, size: number, maxBytes: number): FileCheckError | null {
  if (!name || name.length > 255) return { ok: false, code: 'bad_name', message: 'ファイル名が不正、または長すぎます（255文字まで）' };
  if (size <= 0) return { ok: false, code: 'empty_file', message: '0バイトのファイルはアップロードできません' };
  if (size > maxBytes) {
    return { ok: false, code: 'too_large', message: `ファイルサイズが上限（${Math.floor(maxBytes / 1024 / 1024)}MB）を超えています` };
  }
  const ext = extOf(name);
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { ok: false, code: 'blocked_type', message: `安全のため .${ext} 形式はアップロードできません（必要な場合はZIPにまとめてください）` };
  }
  return null;
}

/** 実体検査: 一時ファイル受信完了後 */
export async function inspectFile(localPath: string, name: string): Promise<FileCheckResult | FileCheckError> {
  const ext = extOf(name);
  const st = await fs.stat(localPath);
  if (st.size === 0) return { ok: false, code: 'empty_file', message: '0バイトのファイルはアップロードできません' };
  const detected = await fileTypeFromFile(localPath);
  if (detected && BLOCKED_SNIFF_EXT.has(detected.ext)) {
    return { ok: false, code: 'blocked_type', message: '実行形式のファイルはアップロードできません' };
  }
  const head = await readHead(localPath, 4096);
  if (!detected && looksLikeExecutable(head)) {
    return { ok: false, code: 'blocked_type', message: '実行形式のファイルはアップロードできません' };
  }
  const rule = RULES[ext];
  let mime: string;
  if (rule) {
    if (detected) {
      if (!rule.sniff.includes(detected.ext)) {
        return { ok: false, code: 'type_mismatch', message: `拡張子（.${ext}）とファイルの内容（${detected.ext}）が一致しません` };
      }
    } else if (!rule.allowUndetected) {
      return { ok: false, code: 'type_mismatch', message: `拡張子（.${ext}）とファイルの内容が一致しません` };
    }
    // SVG/テキスト系は保存を許可するが、previewKind='none' となり配信は常にダウンロード扱い
    mime = rule.mime;
    if (detected && ['mp4', 'mov', 'm4v', 'webm', 'jpg', 'png', 'gif', 'webp', 'pdf'].includes(detected.ext)) mime = detected.mime;
  } else {
    // 未知の拡張子: 実行形式でなければ汎用バイナリとして保存（プレビューなし・ダウンロードのみ）
    mime = 'application/octet-stream';
  }
  let previewKind: PreviewKind = 'none';
  if (PREVIEW_IMAGE.has(mime)) previewKind = 'image';
  else if (mime === 'application/pdf') previewKind = 'pdf';
  else if (PREVIEW_VIDEO.has(mime)) previewKind = 'video';
  const result: FileCheckResult = { ok: true, mime, ext, previewKind };
  if (previewKind === 'image') {
    const dim = imageSize(head, mime);
    if (dim) {
      result.width = dim.width;
      result.height = dim.height;
    }
  }
  return result;
}

async function readHead(p: string, n: number): Promise<Buffer> {
  const fh = await fs.open(p, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function looksLikeExecutable(b: Buffer): boolean {
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return true; // MZ
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true; // ELF
  if (b.length >= 4) {
    const m = b.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(m)) return true; // Mach-O / fat
  }
  if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return true; // #! shebang
  return false;
}

/** 主要画像形式のヘッダから寸法を読む（ピン座標は相対値なので参考情報） */
export function imageSize(b: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mime === 'image/gif' && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (mime === 'image/webp' && b.length >= 30) {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Page, fmtDate, useApi, useTitle, useToast } from './ui';
import { MARKER_COLOR_FIX, MARKER_COLOR_KEEP, buildInstructionText, splitPins, type PinType, type SheetInfo } from '../../../shared/correctionSheet';
import type { FileDto } from './Review';

interface SheetPin {
  commentId: string;
  number: number;
  type: PinType;
  typeLabel: string;
  text: string;
  x: number;
  y: number;
  resolved: boolean;
  authorType: 'operator' | 'client';
  authorName: string;
}

interface Sheet {
  projectName: string;
  deliverable: { id: string; title: string };
  version: { id: string; versionNumber: number; status: string };
  file: FileDto;
  canAnnotate: boolean;
  changeRequest: { id: string; clientName: string; body: string; createdAt: string } | null;
  pins: SheetPin[];
  text: string;
  info: SheetInfo;
}

// 元ツールのマーカー描画（直径 = 短辺 × 5%、最小 20px。修正=赤丸、変更しない=青の角丸四角、白縁＋暗い外縁＋影）
const SIZE_RATIO = 0.05;
const MIN_DIAMETER = 20;
const MARKER_FONT = 'system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif';

function markerPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, keep: boolean) {
  ctx.beginPath();
  if (keep) {
    const rr = r * 0.5;
    const x = cx - r;
    const y = cy - r;
    const w = r * 2;
    const h = r * 2;
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  } else {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
}

function drawMarker(ctx: CanvasRenderingContext2D, cx: number, cy: number, d: number, num: number, keep: boolean) {
  const r = d / 2;
  const border = Math.max(2, d * 0.08);
  const outline = Math.max(1, d * 0.03);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = d * 0.15;
  ctx.shadowOffsetY = d * 0.04;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  markerPath(ctx, cx, cy, r + outline, keep);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = '#ffffff';
  markerPath(ctx, cx, cy, r, keep);
  ctx.fill();
  ctx.fillStyle = keep ? MARKER_COLOR_KEEP : MARKER_COLOR_FIX;
  markerPath(ctx, cx, cy, r - border, keep);
  ctx.fill();
  const fs = d * (num >= 100 ? 0.32 : num >= 10 ? 0.42 : 0.52);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${fs.toFixed(1)}px ${MARKER_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(num), cx, cy + d * 0.02);
  ctx.restore();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = src;
  });
}

/** 番号入り画像（元画像の実寸＋番号マーカー。JPEGはJPEG、それ以外はPNG）。元ファイルは変更しない */
async function makeNumberedImage(sheet: Sheet): Promise<{ blob: Blob; ext: string }> {
  const img = await loadImage(sheet.file.url);
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  const SAFE = 16777216; // ブラウザのCanvas上限対策（4096²相当を超えたら縮小）
  if (w * h > SAFE) {
    const s = Math.sqrt(SAFE / (w * h));
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('この端末では画像を作成できません');
  const jpeg = sheet.file.mime === 'image/jpeg';
  if (jpeg) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const d = Math.max(MIN_DIAMETER, SIZE_RATIO * Math.min(w, h));
  for (const p of [...sheet.pins].sort((a, b) => a.number - b.number)) drawMarker(ctx, p.x * w, p.y * h, d, p.number, p.type === 'keep');
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, jpeg ? 'image/jpeg' : 'image/png', jpeg ? 0.95 : undefined));
  if (!blob) throw new Error('画像を作成できませんでした（画像が大きすぎる可能性があります）');
  return { blob, ext: jpeg ? 'jpg' : 'png' };
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60) || 'sheet';

/**
 * Client Portal 修正指示 — 修正指示書（運営者・顧客共通）
 * 番号入り画像＋【修正指示】【変更しない箇所】の一覧。印刷/PDF保存・番号入り画像の保存・テキスト保存/コピー。
 */
export function CorrectionSheetPage({ base, versionId, changeRequestId, backTo }: { base: string; versionId: string; changeRequestId?: string | null; backTo: string }) {
  const [includeResolved, setIncludeResolved] = useState(false);
  const qs = changeRequestId ? `changeRequestId=${encodeURIComponent(changeRequestId)}` : `includeResolved=${includeResolved ? 1 : 0}`;
  const st = useApi<Sheet>(`${base}/versions/${versionId}/instructions?${qs}`, [base, versionId, qs]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useTitle('修正指示書');
  return (
    <Page state={st}>
      {(s) => {
        const sp = splitPins(s.pins);
        const fileBase = `修正指示_${safeName(s.deliverable.title)}_v${s.version.versionNumber}`;
        return (
          <div className="stack" data-testid="correction-sheet">
            <div className="row no-print">
              <Link to={backTo} className="btn ghost small">
                ‹ 確認画面へ戻る
              </Link>
            </div>
            <div>
              <div className="muted small">Client Portal 修正指示</div>
              <h1 style={{ margin: '2px 0' }}>
                修正指示書: {s.deliverable.title} v{s.version.versionNumber}
              </h1>
              <div className="muted small">
                案件: {s.projectName} ／ 作成日: {s.info.date?.replace(/-/g, '/')}
                {s.changeRequest && (
                  <>
                    {' '}
                    ／ {fmtDate(s.changeRequest.createdAt)} の修正依頼（{s.changeRequest.clientName}）時点のピン
                  </>
                )}
              </div>
            </div>
            <div className="card no-print">
              <div className="row">
                <button className="btn small primary" onClick={() => window.print()}>
                  🖨 印刷 / PDF保存
                </button>
                <button
                  className="btn small"
                  disabled={busy || !s.canAnnotate}
                  data-testid="sheet-save-image"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await makeNumberedImage(s);
                      download(r.blob, `${fileBase}.${r.ext}`);
                    } catch (e) {
                      toast((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  🖼 番号入り画像を保存
                </button>
                <a className="btn small" href={`${base}/versions/${versionId}/instructions?${qs}&format=txt`} data-testid="sheet-save-text">
                  📄 テキストを保存
                </a>
                <button
                  className="btn small"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(s.text);
                      toast('修正指示をコピーしました');
                    } catch {
                      toast('コピーできませんでした。下のテキスト欄を選択してコピーしてください');
                    }
                  }}
                >
                  📋 修正指示をコピー
                </button>
              </div>
              {!s.changeRequest && (
                <label className="check small" style={{ marginTop: 8 }}>
                  <input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} />
                  <span>解決済み（対応済み）のピンも含める</span>
                </label>
              )}
              <div className="muted small" style={{ marginTop: 6 }}>
                番号はピンを置いた順に付き、ピンを削除しても他の番号は変わりません。元の画像ファイルは変更されません。
              </div>
            </div>
            <div className="card" style={{ textAlign: 'center' }}>
              <div className="sheet-img" data-testid="sheet-image">
                <img src={s.file.url} alt={`${s.deliverable.title} v${s.version.versionNumber}`} />
                {s.pins.map((p) => (
                  <span key={p.commentId} className={`mk ${p.type === 'keep' ? 'keep' : ''}`} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} aria-label={`${p.number}番`}>
                    {p.number}
                  </span>
                ))}
              </div>
            </div>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>【修正指示】</h2>
              {sp.fix.length === 0 ? (
                <p className="muted">（なし）</p>
              ) : (
                <ul className="sheet-list" data-testid="sheet-fix">
                  {sp.fix.map((p) => (
                    <li key={p.commentId}>
                      <span className="pinnum">{p.number}</span>
                      <span className="badge warn">{p.typeLabel}</span> {p.resolved && <span className="badge ok">対応済み</span>}
                      <span className="muted small"> {p.authorName}</span>
                      <div className="pre" style={{ marginTop: 4 }}>{p.text}</div>
                    </li>
                  ))}
                </ul>
              )}
              {sp.keep.length > 0 && (
                <>
                  <h2>【変更しない箇所】</h2>
                  <p className="muted small">青い四角の番号は「変更しない箇所」です。</p>
                  <ul className="sheet-list" data-testid="sheet-keep">
                    {sp.keep.map((p) => (
                      <li key={p.commentId}>
                        <span className="pinnum keep">{p.number}</span>
                        <span className="muted small"> {p.authorName}</span>
                        <div className="pre" style={{ marginTop: 4 }}>{p.text}</div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {s.changeRequest && (
                <>
                  <h2>【修正依頼の内容】</h2>
                  <div className="pre">{s.changeRequest.body}</div>
                </>
              )}
            </div>
            <div className="card no-print">
              <h3 style={{ marginTop: 0 }}>修正指示テキスト（チャット・メールに貼り付け用）</h3>
              <textarea readOnly value={buildInstructionText(s.info, s.pins)} style={{ minHeight: 200 }} onFocus={(e) => e.currentTarget.select()} data-testid="sheet-text" />
            </div>
          </div>
        );
      }}
    </Page>
  );
}

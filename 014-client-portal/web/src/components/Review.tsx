import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, del, patch, post } from '../api';
import { AsyncButton, StatusBadge, fmtDate, fmtSize, useOnline, useToast } from './ui';

export interface FileDto {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  previewKind: 'image' | 'pdf' | 'video' | 'none';
  url: string;
  downloadUrl: string;
  width: number | null;
  height: number | null;
}

export interface Approval {
  id: string;
  versionId: string;
  versionNumber: number;
  clientName: string;
  fileSha256: string;
  comment: string;
  approvedAt: string;
  revokedAt: string | null;
  revokedByType: string | null;
  revokeReason: string | null;
}

export interface VersionDto {
  id: string;
  versionNumber: number;
  isLatest: boolean;
  note: string;
  checklist: string[];
  reviewDueDate: string | null;
  status: string;
  statusLabel: string;
  submittedAt: string;
  file: FileDto;
  commentCount: number;
  openCommentCount: number;
  approval: Approval | null;
  approvalHistory: Approval[];
  changeRequests: { id: string; clientName: string; body: string; createdAt: string }[];
}

export interface DeliverableDto {
  id: string;
  title: string;
  category: string;
  description: string;
  status: string;
  statusLabel: string;
  latestVersionNumber: number;
  versions: VersionDto[];
}

export interface CommentDto {
  id: string;
  versionId: string;
  parentId: string | null;
  authorType: 'operator' | 'client';
  authorName: string;
  mine: boolean;
  body: string;
  deleted: boolean;
  pin: { x: number; y: number; number: number } | null;
  resolved: boolean;
  edited: boolean;
  createdAt: string;
}

/** 画像上ピン。座標は表示サイズではなく元画像に対する相対値（0〜1）で扱う */
export function PinImage({
  src,
  alt,
  pins,
  adding,
  draft,
  focusId,
  onPick,
  onPinClick,
}: {
  src: string;
  alt: string;
  pins: { id: string; x: number; y: number; number: number; resolved: boolean }[];
  adding: boolean;
  draft: { x: number; y: number } | null;
  focusId: string | null;
  onPick: (x: number, y: number) => void;
  onPinClick: (id: string) => void;
}) {
  const ref = useRef<HTMLImageElement>(null);
  function pick(e: React.MouseEvent<HTMLDivElement>) {
    if (!adding || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    onPick(Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000);
  }
  return (
    <div className={`pinwrap ${adding ? 'adding' : ''}`} onClick={pick} data-testid="pin-image">
      <img ref={ref} src={src} alt={alt} draggable={false} />
      {pins.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`pin ${p.resolved ? 'resolved' : ''} ${focusId === p.id ? 'focus' : ''}`}
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
          onClick={(e) => {
            e.stopPropagation();
            onPinClick(p.id);
          }}
          aria-label={`ピン${p.number}`}
          data-testid={`pin-${p.number}`}
        >
          <span>{p.number}</span>
        </button>
      ))}
      {draft && (
        <div className="pin draft" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }}>
          <span>＋</span>
        </div>
      )}
    </div>
  );
}

export function FilePreview({ file, children }: { file: FileDto; children?: ReactNode }) {
  if (file.previewKind === 'image' && children) return <div className="preview" style={{ textAlign: 'center' }}>{children}</div>;
  if (file.previewKind === 'image')
    return (
      <div className="preview">
        <img src={file.url} alt={file.name} />
      </div>
    );
  if (file.previewKind === 'pdf')
    return (
      <div className="preview">
        <iframe src={file.url} title={file.name} />
        <div className="small muted" style={{ padding: 8, lineHeight: 1.4 }}>
          PDFが表示されない場合（一部のスマートフォン）は下の「ダウンロード」から開いてください。
        </div>
      </div>
    );
  if (file.previewKind === 'video')
    return (
      <div className="preview">
        <video src={file.url} controls playsInline preload="metadata" style={{ width: '100%', maxHeight: '70vh' }} />
        <div className="small muted" style={{ padding: 8 }}>
          再生できない形式の場合はダウンロードしてご確認ください。
        </div>
      </div>
    );
  return (
    <div className="card flat" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '2rem' }}>📄</div>
      <div>{file.name}</div>
      <div className="muted small">この形式はブラウザでプレビューできません。ダウンロードしてご確認ください。</div>
    </div>
  );
}

function draftKey(versionId: string) {
  return `cp-draft:${versionId}`;
}

/**
 * 制作物の確認画面（運営者・顧客共通）: version切替、プレビュー、画像ピン、コメント。
 * base: '/api/app/projects/:id' または '/api/portal/projects/:id'
 */
export function ReviewPanel({
  base,
  deliverable,
  comments,
  selectedId,
  onSelect,
  onChanged,
  actions,
}: {
  base: string;
  deliverable: DeliverableDto;
  comments: Record<string, CommentDto[]>;
  selectedId: string;
  onSelect: (id: string) => void;
  onChanged: () => void;
  actions?: (v: VersionDto) => ReactNode;
}) {
  const v = deliverable.versions.find((x) => x.id === selectedId) ?? deliverable.versions[0];
  const list = comments[v.id] ?? [];
  const [adding, setAdding] = useState(false);
  const [draftPin, setDraftPin] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<CommentDto | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const online = useOnline();
  const toast = useToast();
  const formRef = useRef<HTMLTextAreaElement>(null);

  // 未送信の下書き（端末内のみ・自動送信しない）
  useEffect(() => {
    try {
      const d = localStorage.getItem(draftKey(v.id));
      setText(d ?? '');
    } catch {
      setText('');
    }
    setDraftPin(null);
    setAdding(false);
    setReplyTo(null);
  }, [v.id]);
  useEffect(() => {
    try {
      if (text) localStorage.setItem(draftKey(v.id), text);
      else localStorage.removeItem(draftKey(v.id));
    } catch {
      /* ignore */
    }
  }, [text, v.id]);

  const pins = useMemo(
    () => list.filter((c) => c.pin && !c.deleted).map((c) => ({ id: c.id, x: c.pin!.x, y: c.pin!.y, number: c.pin!.number, resolved: c.resolved })),
    [list],
  );
  const roots = list.filter((c) => !c.parentId);
  const replies = (id: string) => list.filter((c) => c.parentId === id);
  const canPin = v.file.previewKind === 'image';

  async function send() {
    setError(null);
    if (!text.trim()) return setError('コメントを入力してください');
    try {
      await post(`${base}/versions/${v.id}/comments`, { body: text, pin: draftPin, parentId: replyTo?.id ?? null });
      setText('');
      setDraftPin(null);
      setAdding(false);
      setReplyTo(null);
      toast('コメントを送信しました');
      onChanged();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  const comment = (c: CommentDto, isReply = false) => (
    <div key={c.id} className={`comment ${isReply ? 'reply' : ''}`} id={`c-${c.id}`} style={focusId === c.id ? { background: 'var(--primary-soft)' } : undefined}>
      <div className="row between">
        <div className="who">
          {c.pin && <span className={`pinnum ${c.resolved ? 'resolved' : ''}`}>{c.pin.number}</span>}
          {c.authorName}
          <span className="badge" style={{ marginLeft: 6 }}>
            {c.authorType === 'operator' ? '制作側' : 'お客様'}
          </span>
        </div>
        <span className="muted small">{fmtDate(c.createdAt)}</span>
      </div>
      {editing?.id === c.id ? (
        <div>
          <textarea value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} aria-label="コメントを編集" />
          <div className="row">
            <AsyncButton
              className="btn small primary"
              onClick={async () => {
                try {
                  await patch(`${base}/comments/${c.id}`, { body: editing.body });
                  setEditing(null);
                  onChanged();
                } catch (e) {
                  toast((e as ApiError).message);
                }
              }}
            >
              保存
            </AsyncButton>
            <button className="btn small ghost" onClick={() => setEditing(null)}>
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        <div className="pre">{c.deleted ? <span className="muted">（削除されたコメント）</span> : c.body}</div>
      )}
      {!c.deleted && editing?.id !== c.id && (
        <div className="row small" style={{ marginTop: 4 }}>
          {c.edited && <span className="muted">（編集済み）</span>}
          {c.resolved && <span className="badge ok">解決済み</span>}
          {!isReply && (
            <button className="btn ghost small" onClick={() => (setReplyTo(c), formRef.current?.focus())}>
              返信
            </button>
          )}
          {!isReply && (
            <AsyncButton
              className="btn ghost small"
              onClick={async () => {
                try {
                  await post(`${base}/comments/${c.id}/resolve`, { resolved: !c.resolved });
                  onChanged();
                } catch (e) {
                  toast((e as ApiError).message);
                }
              }}
            >
              {c.resolved ? '未解決に戻す' : '解決済みにする'}
            </AsyncButton>
          )}
          {c.mine && (
            <>
              <button className="btn ghost small" onClick={() => setEditing({ id: c.id, body: c.body })}>
                編集
              </button>
              <AsyncButton
                className="btn ghost small"
                onClick={async () => {
                  if (!confirm('このコメントを削除しますか？')) return;
                  try {
                    await del(`${base}/comments/${c.id}`);
                    onChanged();
                  } catch (e) {
                    toast((e as ApiError).message);
                  }
                }}
              >
                削除
              </AsyncButton>
            </>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="stack">
      {deliverable.versions.length > 1 && (
        <div className="versionbar" role="tablist" aria-label="バージョン">
          {deliverable.versions.map((x) => (
            <button key={x.id} className={`btn small ${x.id === v.id ? 'primary' : ''}`} onClick={() => onSelect(x.id)} role="tab" aria-selected={x.id === v.id}>
              v{x.versionNumber}
              {x.isLatest ? '（最新）' : '（旧版）'}
            </button>
          ))}
        </div>
      )}
      {!v.isLatest && (
        <div className="alert warn" role="alert">
          これは旧版（v{v.versionNumber}）です。確認・承認は最新版（v{deliverable.latestVersionNumber}）で行ってください。
          <div style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => onSelect(deliverable.versions[0].id)}>
              最新版を表示
            </button>
          </div>
        </div>
      )}
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>
            {deliverable.title} <span className="badge info">v{v.versionNumber}</span>
          </h2>
          <StatusBadge status={v.status} label={v.statusLabel} />
        </div>
        <div className="muted small">
          提出: {fmtDate(v.submittedAt)}
          {v.reviewDueDate && <> ／ 確認期限: {fmtDate(v.reviewDueDate)}</>}
        </div>
        {v.note && <p className="pre" style={{ marginTop: 8 }}>{v.note}</p>}
        {v.checklist.length > 0 && (
          <div className="small" style={{ marginTop: 6 }}>
            <strong>確認していただきたい点:</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
              {v.checklist.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <FilePreview file={v.file}>
        {canPin && (
          <PinImage
            src={v.file.url}
            alt={`${deliverable.title} v${v.versionNumber}`}
            pins={pins}
            adding={adding}
            draft={draftPin}
            focusId={focusId}
            onPick={(x, y) => {
              setDraftPin({ x, y });
              setReplyTo(null);
              setTimeout(() => formRef.current?.focus(), 0);
            }}
            onPinClick={(id) => {
              setFocusId(id);
              document.getElementById(`c-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          />
        )}
      </FilePreview>
      <div className="row">
        <a className="btn small" href={v.file.downloadUrl}>
          ⬇ ダウンロード（{fmtSize(v.file.size)}）
        </a>
        <span className="muted small">{v.file.name}</span>
      </div>

      {actions?.(v)}

      {v.changeRequests.length > 0 && (
        <div className="card warn">
          <h3>この版への修正依頼</h3>
          {v.changeRequests.map((c) => (
            <div key={c.id} className="small" style={{ marginTop: 6 }}>
              <div className="muted">
                {fmtDate(c.createdAt)} {c.clientName}
              </div>
              <div className="pre">{c.body}</div>
            </div>
          ))}
        </div>
      )}
      {v.approvalHistory.length > 0 && (
        <div className="card flat small">
          <h3>承認履歴（v{v.versionNumber}）</h3>
          {v.approvalHistory.map((a) => (
            <div key={a.id} style={{ marginTop: 6 }}>
              {a.revokedAt ? '✕' : '✓'} {fmtDate(a.approvedAt)} {a.clientName} が承認
              {a.comment && <>「{a.comment}」</>}
              <div className="muted" style={{ wordBreak: 'break-all' }}>
                承認時ファイルSHA-256: {a.fileSha256.slice(0, 16)}…
              </div>
              {a.revokedAt && (
                <div style={{ color: 'var(--danger)' }}>
                  {fmtDate(a.revokedAt)} に取消（{a.revokedByType === 'operator' ? '制作側' : 'お客様'}）: {a.revokeReason}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>コメント（{list.filter((c) => !c.deleted).length}）</h2>
          {canPin && (
            <button
              className={`btn small ${adding ? 'primary' : ''}`}
              onClick={() => {
                setAdding(!adding);
                setDraftPin(null);
              }}
              data-testid="pin-mode"
            >
              📍 {adding ? '画像をタップして位置を指定' : '画像にピンを置く'}
            </button>
          )}
        </div>
        {roots.length === 0 && <p className="muted small" style={{ marginTop: 8 }}>まだコメントはありません。</p>}
        {roots.map((c) => (
          <div key={c.id}>
            {comment(c)}
            {replies(c.id).map((r) => comment(r, true))}
          </div>
        ))}
        <div style={{ marginTop: 12 }}>
          {replyTo && (
            <div className="alert small">
              返信先: {replyTo.authorName}「{replyTo.body.slice(0, 30)}」
              <button className="btn ghost small" onClick={() => setReplyTo(null)}>
                解除
              </button>
            </div>
          )}
          {draftPin && (
            <div className="alert small">
              📍 ピン位置を指定しました。コメントを書いて送信してください。
              <button className="btn ghost small" onClick={() => setDraftPin(null)}>
                ピンを外す
              </button>
            </div>
          )}
          <label className="field" style={{ marginBottom: 6 }}>
            <span>コメント{text && <span className="badge warn" style={{ marginLeft: 6 }}>未送信の下書き</span>}</span>
            <textarea
              ref={formRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={canPin ? '気になる箇所は「画像にピンを置く」で位置を指定できます' : 'コメントを入力'}
              data-testid="comment-input"
            />
          </label>
          {error && <div className="alert error">{error}</div>}
          {!online && <div className="alert warn small">オフラインです。下書きは端末に保存されています（未送信）。再接続後に送信してください。</div>}
          <AsyncButton className="btn primary block" onClick={send}>
            コメントを送信
          </AsyncButton>
        </div>
      </div>
    </div>
  );
}

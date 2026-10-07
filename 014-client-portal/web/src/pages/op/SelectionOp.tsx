import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, del, patch, post } from '../../api';
import { AsyncButton, Empty, Page, fmtDate, useApi, useTitle, useToast } from '../../components/ui';
import { Uploader } from '../../components/Uploader';
import { CheckResultView } from '../portal/PortalSelect';
import { SELECTION_MAX_PHOTOS, SELECTION_WARN_PHOTOS, checkSelection } from '../../../../shared/photoSelect';

interface SetSummary {
  id: string;
  title: string;
  message: string;
  status: 'draft' | 'open' | 'closed';
  statusLabel: string;
  photoCount: number;
  showNames: boolean;
  openedAt: string | null;
  closedAt: string | null;
  submittedCount: number;
  lastSubmittedAt: string | null;
}

interface Detail {
  projectName: string;
  set: SetSummary;
  photos: { id: string; number: string; position: number; name: string; sameName: boolean; pickedBy: string[]; file: { id: string; url: string; downloadUrl: string } }[];
  responses: {
    clientId: string;
    clientName: string;
    note: string;
    submittedAt: string | null;
    picksUpdatedAt: string | null;
    changedAfterSubmit: boolean;
    picks: { photoId: string; number: string; name: string }[];
  }[];
}

/** Client Portal 写真セレクト（運営者）: 案件詳細のタブ */
export function SelectionsTab({ projectId }: { projectId: string }) {
  const st = useApi<{ selections: SetSummary[] }>(`/api/app/projects/${projectId}/selections`, [projectId]);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('使いたい写真を選んで「送信」を押してください。番号（例: 001, 007、012）での入力もできます。');
  const nav = useNavigate();
  const toast = useToast();
  return (
    <div className="stack">
      <div className="alert small">
        📷 Client Portal 写真セレクト: 写真をまとめて登録すると 001, 002… の番号が付きます。お客様はポータルで写真をタップするか番号を入力して選び、送信します。結果は番号と元ファイル名の対応で確認・CSV書き出しできます。
      </div>
      <Page state={st}>
        {(d) =>
          d.selections.length === 0 ? (
            <Empty>写真セレクトはまだありません。</Empty>
          ) : (
            <div className="list">
              {d.selections.map((s) => (
                <Link key={s.id} to={`/app/projects/${projectId}/selections/${s.id}`} className="item" data-testid="op-selection-item">
                  <span style={{ fontSize: '1.6rem' }}>📷</span>
                  <div className="grow">
                    <div className="title">{s.title}</div>
                    <div className="muted small">
                      {s.photoCount}枚 ／ 送信 {s.submittedCount}件{s.lastSubmittedAt && <>（最終 {fmtDate(s.lastSubmittedAt)}）</>}
                    </div>
                  </div>
                  <span className={`badge ${s.status === 'open' ? 'info' : s.status === 'draft' ? 'warn' : ''}`}>{s.statusLabel}</span>
                  <span className="chev" />
                </Link>
              ))}
            </div>
          )
        }
      </Page>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>新しい写真セレクトを作成</h3>
        <label className="field">
          <span>セレクト名</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 9/28 撮影分" data-testid="selection-title" />
        </label>
        <label className="field">
          <span>お客様へのメッセージ</span>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} style={{ minHeight: 60 }} />
        </label>
        <AsyncButton
          className="btn primary"
          onClick={async () => {
            try {
              const r = await post(`/api/app/projects/${projectId}/selections`, { title, message, showNames: true });
              nav(`/app/projects/${projectId}/selections/${r.id}`);
            } catch (e) {
              toast((e as ApiError).message);
            }
          }}
        >
          作成して写真を追加
        </AsyncButton>
      </div>
    </div>
  );
}

/** Client Portal 写真セレクト（運営者）: セット詳細 */
export function SelectionOp() {
  const { pid, sid } = useParams();
  const base = `/api/app/projects/${pid}/selections/${sid}`;
  const st = useApi<Detail>(base, [base]);
  const [reply, setReply] = useState('');
  const [edit, setEdit] = useState<{ title: string; message: string; showNames: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const toast = useToast();
  const nav = useNavigate();
  useTitle(st.data?.set.title ?? '写真セレクト');
  const reloadSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => st.reload(), 600);
  };
  const act = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      st.reload();
    } catch (e) {
      toast((e as ApiError).message);
    }
  };
  return (
    <Page state={st}>
      {(d) => {
        const s = d.set;
        const draft = s.status === 'draft';
        const check = reply.trim() ? checkSelection(reply, d.photos.map((p) => p.name)) : null;
        return (
          <div className="stack">
            <div className="muted small">
              <Link to={`/app/projects/${pid}?tab=selections`}>{d.projectName}</Link> ／ 写真セレクト
            </div>
            <div className="row between">
              <h1 style={{ margin: 0 }}>
                📷 {s.title} <span className={`badge ${s.status === 'open' ? 'info' : s.status === 'draft' ? 'warn' : ''}`} data-testid="selection-status">{s.statusLabel}</span>
              </h1>
              <div className="row">
                {s.status !== 'open' && (
                  <AsyncButton className="btn primary small" disabled={d.photos.length === 0} onClick={act(() => post(`${base}/status`, { status: 'open' }))}>
                    {draft ? 'お客様に公開（選択受付を開始）' : '受付を再開'}
                  </AsyncButton>
                )}
                {s.status === 'open' && (
                  <AsyncButton className="btn small" onClick={act(() => post(`${base}/status`, { status: 'closed' }))}>
                    受付を終了
                  </AsyncButton>
                )}
                <button className="btn small ghost" onClick={() => setEdit({ title: s.title, message: s.message, showNames: s.showNames })}>
                  設定
                </button>
                {draft && (
                  <AsyncButton
                    className="btn small danger"
                    onClick={async () => {
                      if (!confirm('このセレクトと写真を削除しますか？')) return;
                      try {
                        await del(base);
                        nav(`/app/projects/${pid}?tab=selections`);
                      } catch (e) {
                        toast((e as ApiError).message);
                      }
                    }}
                  >
                    削除
                  </AsyncButton>
                )}
              </div>
            </div>
            {draft && <div className="alert warn small">準備中: お客様にはまだ表示されていません。写真の並べ替え・削除は公開前のみできます（公開後に番号が変わらないようにするため）。</div>}
            {s.status === 'open' && <div className="alert small">公開中: 番号は固定されています。追加した写真は末尾の番号になります。</div>}
            {s.message && <div className="card flat pre small">{s.message}</div>}
            {edit && (
              <div className="card">
                <label className="field">
                  <span>セレクト名</span>
                  <input type="text" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
                </label>
                <label className="field">
                  <span>お客様へのメッセージ</span>
                  <textarea value={edit.message} onChange={(e) => setEdit({ ...edit, message: e.target.value })} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={edit.showNames} onChange={(e) => setEdit({ ...edit, showNames: e.target.checked })} />
                  <span>お客様に元ファイル名を表示する（OFFにすると番号だけを表示）</span>
                </label>
                <div className="row">
                  <AsyncButton className="btn primary small" onClick={act(async () => (await patch(base, edit), setEdit(null)))}>
                    保存
                  </AsyncButton>
                  <button className="btn small ghost" onClick={() => setEdit(null)}>
                    キャンセル
                  </button>
                </div>
              </div>
            )}

            <div className="card">
              <h2 style={{ marginTop: 0 }}>選択結果</h2>
              {d.responses.length === 0 && <p className="muted small">まだ選択はありません。</p>}
              {d.responses.map((r) => (
                <div key={r.clientId} style={{ marginBottom: 12 }} data-testid="selection-response">
                  <div className="row between">
                    <strong>
                      {r.clientName}（{r.picks.length}枚）
                    </strong>
                    <span className={`badge ${r.submittedAt ? (r.changedAfterSubmit ? 'warn' : 'ok') : ''}`}>
                      {r.submittedAt ? (r.changedAfterSubmit ? `${fmtDate(r.submittedAt)} 送信後に変更あり（未送信）` : `${fmtDate(r.submittedAt)} 送信`) : '選択中（未送信）'}
                    </span>
                  </div>
                  {r.note && <div className="pre small">コメント: {r.note}</div>}
                  <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }} data-testid="response-picks">
                    {r.picks.map((p) => (
                      <li key={p.photoId}>
                        {p.number} → {p.name}
                      </li>
                    ))}
                  </ul>
                  <div className="row" style={{ marginTop: 6 }}>
                    <a className="btn small" href={`${base}/export?kind=picks&format=csv&clientId=${r.clientId}`}>
                      ⬇ CSV
                    </a>
                    <a className="btn small" href={`${base}/export?kind=picks&format=txt&clientId=${r.clientId}`}>
                      ⬇ テキスト
                    </a>
                  </div>
                </div>
              ))}
              <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                <a className="btn small" href={`${base}/export?kind=picks&format=csv`} data-testid="export-picks-csv">
                  ⬇ 選択結果CSV（全員分）
                </a>
                <a className="btn small" href={`${base}/export?kind=map&format=csv`}>
                  ⬇ 番号対応表CSV（全写真）
                </a>
              </div>
            </div>

            <div className="card">
              <h3 style={{ marginTop: 0 }}>選択番号確認（メール・LINEなどで届いた番号を貼り付け）</h3>
              <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="例: 001, 007、012" style={{ minHeight: 50 }} data-testid="op-reply-input" />
              {check && <CheckResultView check={check} />}
            </div>

            {s.status !== 'closed' && (
              <div className="card">
                <h3 style={{ marginTop: 0 }}>写真を追加</h3>
                <p className="muted small" style={{ marginTop: 0 }}>
                  JPG / PNG / WEBP / GIF。選んだ写真はファイル名順（IMG_2 → IMG_10）に並べて末尾に追加します。1セット最大{SELECTION_MAX_PHOTOS}枚
                  （{SELECTION_WARN_PHOTOS}枚を超えるとお客様の端末で重くなることがあります）。同じ写真は二重に登録されません。
                </p>
                <Uploader
                  initUrl={`/api/app/projects/${pid}/uploads`}
                  extra={{ target: { purpose: 'selection_photo', setId: sid } }}
                  mediaButton={false}
                  label="写真を選ぶ（複数可）"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  maxFiles={SELECTION_MAX_PHOTOS}
                  sortByName
                  onUploaded={reloadSoon}
                  onBatchDone={() => st.reload()}
                />
              </div>
            )}

            <div className="row between">
              <h2 style={{ margin: 0 }}>写真（{d.photos.length}枚）</h2>
              {draft && d.photos.length > 1 && (
                <AsyncButton className="btn small" onClick={act(() => post(`${base}/sort-by-name`))}>
                  ファイル名順に並べ替え
                </AsyncButton>
              )}
            </div>
            {d.photos.length === 0 && <Empty>まだ写真がありません。</Empty>}
            <div className="photo-grid">
              {d.photos.map((p, i) => (
                <div key={p.id} className={`photo-card ${p.pickedBy.length ? 'picked' : ''}`} data-testid={`op-photo-${p.number}`}>
                  <div className="row between">
                    <span className="num">{p.number}</span>
                    {p.pickedBy.length > 0 && <span className="badge ok">選択 {p.pickedBy.length}</span>}
                  </div>
                  <a href={p.file.url} target="_blank" rel="noreferrer">
                    <img className="ph" src={p.file.url} alt={p.name} loading="lazy" />
                  </a>
                  <div className="fname">
                    {p.name} {p.sameName && <span className="badge warn">同名あり</span>}
                  </div>
                  {draft && (
                    <div className="row" style={{ gap: 4 }}>
                      <AsyncButton className="btn small" disabled={i === 0} onClick={act(() => post(`${base}/photos/${p.id}/move`, { toNumber: p.position - 1 }))}>
                        ←
                      </AsyncButton>
                      <AsyncButton className="btn small" disabled={i === d.photos.length - 1} onClick={act(() => post(`${base}/photos/${p.id}/move`, { toNumber: p.position + 1 }))}>
                        →
                      </AsyncButton>
                      <AsyncButton
                        className="btn small ghost"
                        onClick={async () => {
                          if (!confirm(`${p.number}（${p.name}）を一覧から削除しますか？`)) return;
                          await act(() => post(`${base}/photos/delete`, { photoIds: [p.id] }))();
                        }}
                      >
                        削除
                      </AsyncButton>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      }}
    </Page>
  );
}

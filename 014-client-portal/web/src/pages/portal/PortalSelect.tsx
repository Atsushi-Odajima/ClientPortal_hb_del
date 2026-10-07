import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, post } from '../../api';
import { AsyncButton, Empty, Page, fmtDate, useApi, useOnline, useTitle, useToast } from '../../components/ui';
import type { SelectionCheckResult } from '../../../../shared/photoSelect';

interface SelectionSummary {
  id: string;
  title: string;
  message: string;
  status: 'open' | 'closed';
  statusLabel: string;
  photoCount: number;
  myPickCount: number;
  submittedAt: string | null;
}

interface SelectionDetail {
  set: SelectionSummary & { showNames: boolean };
  photos: { id: string; number: string; name: string | null; url: string; downloadUrl: string; picked: boolean }[];
  myResponse: { note: string; submittedAt: string | null; changedAfterSubmit: boolean };
}

/** Client Portal 写真セレクト（顧客）: 一覧 */
export function SelectList({ pid }: { pid: string }) {
  useTitle('写真セレクト');
  const st = useApi<{ selections: SelectionSummary[] }>(`/api/portal/projects/${pid}/selections`, [pid]);
  return (
    <Page state={st}>
      {(d) => (
        <div className="stack">
          <h1>写真セレクト</h1>
          {d.selections.length === 0 && <Empty>選んでいただく写真はまだありません。</Empty>}
          <div className="list">
            {d.selections.map((s) => (
              <Link key={s.id} to={`/portal/p/${pid}/select/${s.id}`} className="item" data-testid="selection-item">
                <span style={{ fontSize: '1.8rem' }}>📷</span>
                <div className="grow">
                  <div className="title">{s.title}</div>
                  <div className="small muted">
                    {s.photoCount}枚 ／ 選択中 {s.myPickCount}枚{s.submittedAt && <> ／ {fmtDate(s.submittedAt)} 送信済み</>}
                  </div>
                </div>
                <span className={`badge ${s.status === 'open' ? (s.submittedAt ? 'ok' : 'warn') : ''}`}>{s.status === 'open' ? (s.submittedAt ? '送信済み' : '選んでください') : s.statusLabel}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}

/**
 * Client Portal 写真セレクト（顧客）: 写真をクリック、または番号（例: 001, 007、012）で選んで送信。
 * 選択はその都度サーバーに保存される（PCとスマホで続きから選べる）。送信すると担当者に通知される。
 */
export function SelectPage({ pid }: { pid: string }) {
  const { sid } = useParams();
  const st = useApi<SelectionDetail>(`/api/portal/projects/${pid}/selections/${sid}`, [pid, sid]);
  const [numbers, setNumbers] = useState('');
  const [check, setCheck] = useState<SelectionCheckResult | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyPicked, setOnlyPicked] = useState(false);
  const online = useOnline();
  const toast = useToast();
  useTitle(st.data?.set.title ?? '写真セレクト');
  const base = `/api/portal/projects/${pid}/selections/${sid}`;

  async function savePicked(d: SelectionDetail, ids: string[]) {
    setError(null);
    const prev = d;
    // 画面は先に更新し、保存に失敗したら戻す
    st.setData({ ...d, photos: d.photos.map((p) => ({ ...p, picked: ids.includes(p.id) })), myResponse: { ...d.myResponse, changedAfterSubmit: !!d.myResponse.submittedAt } });
    try {
      await post(`${base}/picks`, { photoIds: ids });
    } catch (e) {
      st.setData(prev);
      setError((e as ApiError).message);
    }
  }

  return (
    <Page state={st}>
      {(d) => {
        const open = d.set.status === 'open';
        const picked = d.photos.filter((p) => p.picked);
        const shown = onlyPicked ? picked : d.photos;
        return (
          <div className="stack">
            <div className="row">
              <Link to={`/portal/p/${pid}/select`} className="btn ghost small">
                ‹ 一覧へ
              </Link>
            </div>
            <div>
              <div className="muted small">Client Portal 写真セレクト</div>
              <h1 style={{ margin: '2px 0' }}>{d.set.title}</h1>
              <span className={`badge ${open ? 'info' : ''}`}>{d.set.statusLabel}</span> <span className="muted small">全{d.photos.length}枚</span>
            </div>
            {d.set.message && <div className="alert pre">{d.set.message}</div>}
            {!open && <div className="alert warn">このセレクトは受付を終了しました。変更が必要な場合は担当者にご連絡ください。</div>}

            <div className="card" data-testid="select-summary">
              <div className="row between">
                <strong>
                  選択中 <span data-testid="picked-count">{picked.length}</span>枚
                </strong>
                {d.myResponse.submittedAt && (
                  <span className={`badge ${d.myResponse.changedAfterSubmit ? 'warn' : 'ok'}`}>
                    {d.myResponse.changedAfterSubmit ? '送信後に変更あり（未送信）' : `${fmtDate(d.myResponse.submittedAt)} 送信済み`}
                  </span>
                )}
              </div>
              <div className="small" style={{ marginTop: 4, wordBreak: 'break-all' }} data-testid="picked-numbers">
                {picked.length ? picked.map((p) => p.number).join(', ') : 'まだ選ばれていません'}
              </div>
              {open && (
                <>
                  <label className="field" style={{ marginTop: 8 }}>
                    <span>担当者へのコメント（任意）</span>
                    <textarea value={note ?? d.myResponse.note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 50 }} placeholder="例: 001 を表紙に使いたいです" />
                  </label>
                  {error && <div className="alert error">{error}</div>}
                  <AsyncButton
                    className="btn primary block"
                    disabled={picked.length === 0}
                    onClick={async () => {
                      setError(null);
                      try {
                        const r = await post(`${base}/submit`, { note: note ?? d.myResponse.note });
                        toast(`${r.count}枚の選択を送信しました`);
                        setNote(null);
                        st.reload();
                      } catch (e) {
                        setError((e as ApiError).message);
                      }
                    }}
                  >
                    {d.myResponse.submittedAt ? 'この内容で送信し直す' : 'この内容で送信する'}
                  </AsyncButton>
                  <div className="muted small" style={{ marginTop: 4 }}>
                    選択は自動で保存されます（パソコンとスマホで続きから選べます）。選び終わったら「送信」を押すと担当者に届きます。
                  </div>
                </>
              )}
            </div>

            {open && (
              <div className="card">
                <h3 style={{ marginTop: 0 }}>番号で選ぶ</h3>
                <p className="small muted" style={{ marginTop: 0 }}>
                  例: 001, 007、012（カンマ・読点・スペース・改行で区切れます。「7」は 007 として扱います）
                </p>
                <textarea value={numbers} onChange={(e) => setNumbers(e.target.value)} style={{ minHeight: 50 }} aria-label="写真番号" data-testid="numbers-input" />
                <div className="row" style={{ marginTop: 6 }}>
                  <AsyncButton
                    className="btn small primary"
                    disabled={!numbers.trim()}
                    onClick={async () => {
                      setError(null);
                      try {
                        const r = await post<{ check: SelectionCheckResult }>(`${base}/picks`, { numbersText: numbers, mode: 'add' });
                        setCheck(r.check);
                        st.reload();
                      } catch (e) {
                        setError((e as ApiError).message);
                      }
                    }}
                  >
                    選択に追加
                  </AsyncButton>
                  <AsyncButton
                    className="btn small"
                    disabled={!numbers.trim()}
                    onClick={async () => {
                      if (!confirm('今の選択をこの番号だけに置き換えますか？')) return;
                      try {
                        const r = await post<{ check: SelectionCheckResult }>(`${base}/picks`, { numbersText: numbers, mode: 'replace' });
                        setCheck(r.check);
                        st.reload();
                      } catch (e) {
                        setError((e as ApiError).message);
                      }
                    }}
                  >
                    この番号だけにする
                  </AsyncButton>
                </div>
                {check && <CheckResultView check={check} />}
              </div>
            )}

            <div className="row between">
              <h2 style={{ margin: 0 }}>写真一覧</h2>
              <label className="check small">
                <input type="checkbox" checked={onlyPicked} onChange={(e) => setOnlyPicked(e.target.checked)} />
                <span>選択中だけ表示</span>
              </label>
            </div>
            <div className="photo-grid">
              {shown.map((p) => (
                <div key={p.id} className={`photo-card ${p.picked ? 'picked' : ''}`} data-testid={`photo-${p.number}`}>
                  <div className="row between">
                    <span className="num">{p.number}</span>
                    {p.picked && <span className="badge ok">選択中</span>}
                  </div>
                  <a href={p.url} target="_blank" rel="noreferrer" title="拡大して見る">
                    <img className="ph" src={p.url} alt={`写真 ${p.number}`} loading="lazy" />
                  </a>
                  {p.name && <div className="fname">{p.name}</div>}
                  {open && (
                    <button
                      type="button"
                      className={`btn small toggle ${p.picked ? 'ok' : ''}`}
                      disabled={!online}
                      aria-pressed={p.picked}
                      onClick={() => savePicked(d, p.picked ? picked.filter((x) => x.id !== p.id).map((x) => x.id) : [...picked.map((x) => x.id), p.id])}
                    >
                      {p.picked ? '✓ 選択中（外す）' : '選ぶ'}
                    </button>
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

/** 番号入力の確認結果（元ツールの「選択番号確認」と同じ表示: 001 → 元ファイル名 / 該当なし / 読み取れなかった文字 / 重複） */
export function CheckResultView({ check }: { check: SelectionCheckResult }) {
  if (check.empty) return <div className="alert warn small">番号が入力されていません。</div>;
  return (
    <div className="small" style={{ marginTop: 8 }} data-testid="check-result">
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {check.results.map((r) => (
          <li key={r.label} style={r.found ? undefined : { color: 'var(--danger)' }}>
            {r.label} → {r.found ? r.name : '該当なし'}
            {r.input !== r.label && <span className="muted">（入力：{r.input}）</span>}
          </li>
        ))}
      </ul>
      {check.duplicates.length > 0 && <div className="muted">重複: {check.duplicates.map((x) => `${x.label}（${x.count}回）`).join('、')}</div>}
      {check.invalid.length > 0 && <div style={{ color: 'var(--danger)' }}>読み取れなかった文字: {check.invalid.join('、')}</div>}
    </div>
  );
}

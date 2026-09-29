import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, get, newIdempotencyKey, post } from '../../api';
import { AsyncButton, Empty, ErrorBox, Loading, Modal, Page, StatusBadge, fmtDate, fmtSize, isOverdue, useApi, useOnline, useTitle, useToast } from '../../components/ui';
import { Uploader } from '../../components/Uploader';
import { ReviewPanel, type CommentDto, type DeliverableDto, type VersionDto } from '../../components/Review';
import { PortalHelp } from './PortalHelp';

interface Me {
  client: { id: string; companyName: string; contactName: string; email: string };
  providerName: string;
  projects: { id: string; name: string }[];
}

export default function PortalApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const load = () => get<Me>('/api/portal/me').then((m) => (setMe(m), setErr(null)), setErr);
    load();
    // オフラインで開いた場合は再接続時に自動で読み込み直す
    window.addEventListener('online', load);
    return () => window.removeEventListener('online', load);
  }, []);
  useEffect(() => {
    if (!me) return;
    const load = () => get('/api/portal/notifications').then((r) => setUnread(r.unread), () => undefined);
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, [me]);
  if (err) {
    return (
      <div className="center-page">
        <div className="card">
          <h1>ページを開けません</h1>
          <p>
            {err.status === 401
              ? '招待リンクから開いてください。リンクの期限が切れている場合は担当者に再発行をご依頼ください。'
              : err.status === 0
                ? '通信できないため読み込めませんでした。電波の良い場所で再度お試しください（接続が戻ると自動で再読み込みします）。'
                : err.message}
          </p>
          <Link className="btn block" to="/portal/login">
            開けない場合
          </Link>
        </div>
      </div>
    );
  }
  if (!me) return <Loading />;
  return (
    <Routes>
      <Route index element={<ProjectList me={me} />} />
      <Route path="notifications" element={<Shell me={me} unread={unread}><Notifications onRead={() => setUnread(0)} /></Shell>} />
      <Route path="help" element={<Shell me={me} unread={unread}><PortalHelp /></Shell>} />
      <Route path="p/:pid/*" element={<ProjectShell me={me} unread={unread} />} />
      <Route path="*" element={<Navigate to="/portal" replace />} />
    </Routes>
  );
}

function Shell({ me, unread, children, pid }: { me: Me; unread: number; children: React.ReactNode; pid?: string }) {
  const nav = useNavigate();
  return (
    <div className="app portal">
      <header className="topbar">
        <Link className="brand" to={pid ? `/portal/p/${pid}` : '/portal'}>
          {me.providerName}
        </Link>
        <span className="spacer" />
        <Link to="/portal/notifications" className="btn ghost small" aria-label={`お知らせ ${unread}件`}>
          🔔{unread > 0 && <span className="badge danger">{unread}</span>}
        </Link>
        <Link to="/portal/help" className="btn ghost small">
          使い方
        </Link>
        <button
          className="btn ghost small"
          onClick={async () => {
            if (!confirm('この端末からログアウトしますか？再度開くには招待リンクが必要です。')) return;
            await post('/api/portal/logout').catch(() => undefined);
            nav('/portal/login');
          }}
        >
          ログアウト
        </button>
      </header>
      <main className="main">{children}</main>
      {pid && (
        <nav className="bottomnav" aria-label="案件メニュー">
          <NavLink end to={`/portal/p/${pid}`}>
            <span className="ico">🏠</span>やること
          </NavLink>
          <NavLink to={`/portal/p/${pid}/requests`}>
            <span className="ico">📤</span>資料
          </NavLink>
          <NavLink to={`/portal/p/${pid}/review`}>
            <span className="ico">👀</span>確認
          </NavLink>
          <NavLink to={`/portal/p/${pid}/deliveries`}>
            <span className="ico">📦</span>納品
          </NavLink>
          <NavLink to={`/portal/p/${pid}/activity`}>
            <span className="ico">🕒</span>履歴
          </NavLink>
        </nav>
      )}
    </div>
  );
}

function ProjectList({ me }: { me: Me }) {
  useTitle('案件一覧');
  const st = useApi<{ projects: { id: string; name: string; clientStatusLabel: string; dueDate: string | null; todoCount: number }[] }>('/api/portal/projects');
  if (st.data && st.data.projects.length === 1) return <Navigate to={`/portal/p/${st.data.projects[0].id}`} replace />;
  return (
    <Shell me={me} unread={0}>
      <h1>{me.client.companyName} 様</h1>
      <Page state={st}>
        {(d) =>
          d.projects.length === 0 ? (
            <Empty>現在ご覧いただける案件はありません。</Empty>
          ) : (
            <div className="list">
              {d.projects.map((p) => (
                <Link key={p.id} to={`/portal/p/${p.id}`} className="item">
                  <div className="grow">
                    <div className="title">{p.name}</div>
                    <div className="muted small">{p.clientStatusLabel}</div>
                  </div>
                  {p.todoCount > 0 && <span className="badge warn">やること {p.todoCount}</span>}
                  <span className="chev" />
                </Link>
              ))}
            </div>
          )
        }
      </Page>
    </Shell>
  );
}

function ProjectShell({ me, unread }: { me: Me; unread: number }) {
  const { pid } = useParams();
  return (
    <Shell me={me} unread={unread} pid={pid}>
      <Routes>
        <Route index element={<ProjectHome pid={pid!} me={me} />} />
        <Route path="requests" element={<Requests pid={pid!} />} />
        <Route path="review" element={<ReviewList pid={pid!} />} />
        <Route path="review/:did" element={<ReviewPage pid={pid!} />} />
        <Route path="deliveries" element={<Deliveries pid={pid!} />} />
        <Route path="activity" element={<Activity pid={pid!} />} />
      </Routes>
    </Shell>
  );
}

interface Todo {
  requests: { total: number; requiredTotal: number; submitted: number; accepted: number; toSubmit: { id: string; title: string; required: boolean; returned: boolean; dueDate: string | null; overdue: boolean }[] };
  reviews: { deliverableId: string; title: string; versionId: string; versionNumber: number; reviewDueDate: string | null; overdue: boolean }[];
  deliverables: { total: number; approved: number };
  deliveries: { id: string; title: string; publishedAt: string; expiresAt: string | null; expired: boolean; downloaded: boolean }[];
}

function ProjectHome({ pid, me }: { pid: string; me: Me }) {
  const st = useApi<{ project: { name: string; clientStatusLabel: string; clientGuidance: string; dueDate: string | null; description: string }; providerName: string; todo: Todo }>(`/api/portal/projects/${pid}`, [pid]);
  useTitle(st.data?.project.name ?? '');
  return (
    <Page state={st}>
      {({ project, todo }) => {
        const pendingDeliveries = todo.deliveries.filter((d) => !d.downloaded && !d.expired);
        const nothing = todo.requests.toSubmit.length === 0 && todo.reviews.length === 0 && pendingDeliveries.length === 0;
        return (
          <div className="stack">
            <div>
              <div className="muted small">{me.client.companyName} 様</div>
              <h1>{project.name}</h1>
              <span className="badge info">{project.clientStatusLabel}</span>
              {project.dueDate && <span className="muted small" style={{ marginLeft: 8 }}>納期予定 {fmtDate(project.dueDate)}</span>}
            </div>
            {project.clientGuidance && <div className="alert pre">{project.clientGuidance}</div>}
            <h2>いま、お願いしたいこと</h2>
            {nothing && <Empty>現在お願いしていることはありません。ありがとうございます。</Empty>}
            {todo.reviews.map((r) => (
              <Link key={r.versionId} to={`/portal/p/${pid}/review/${r.deliverableId}`} className={`card link highlight`} data-testid="todo-review">
                <div className="row between">
                  <strong>👀 {r.title} v{r.versionNumber} をご確認ください</strong>
                  <span className="chev" />
                </div>
                <div className="muted small">
                  内容をご確認のうえ「承認」または「修正を依頼」をお願いします
                  {r.reviewDueDate && <>（期限 {fmtDate(r.reviewDueDate)}{r.overdue && <span className="badge danger" style={{ marginLeft: 4 }}>期限超過</span>}）</>}
                </div>
              </Link>
            ))}
            {todo.requests.toSubmit.length > 0 && (
              <Link to={`/portal/p/${pid}/requests`} className="card link highlight" data-testid="todo-requests">
                <div className="row between">
                  <strong>📤 資料のご提出（未提出 {todo.requests.toSubmit.length}件）</strong>
                  <span className="chev" />
                </div>
                <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                  {todo.requests.toSubmit.map((r) => (
                    <li key={r.id}>
                      {r.title}
                      {!r.required && <span className="muted">（任意）</span>}
                      {r.returned && <span className="badge danger" style={{ marginLeft: 4 }}>再提出のお願い</span>}
                      {r.dueDate && <span className={r.overdue ? '' : 'muted'} style={r.overdue ? { color: 'var(--danger)' } : undefined}> 期限 {fmtDate(r.dueDate)}</span>}
                    </li>
                  ))}
                </ul>
              </Link>
            )}
            {pendingDeliveries.map((d) => (
              <Link key={d.id} to={`/portal/p/${pid}/deliveries`} className="card link highlight">
                <div className="row between">
                  <strong>📦 納品物「{d.title}」をお受け取りください</strong>
                  <span className="chev" />
                </div>
                {d.expiresAt && <div className="muted small">ダウンロード期限 {fmtDate(d.expiresAt)}</div>}
              </Link>
            ))}
            <h2>進み具合</h2>
            <div className="grid cols-2">
              <div className="card">
                <div className="muted small">資料</div>
                <div>
                  <strong>
                    {todo.requests.submitted}/{todo.requests.total}
                  </strong>{' '}
                  提出済み
                </div>
                <div className="progress ok" aria-hidden>
                  <div style={{ width: `${todo.requests.total ? (todo.requests.submitted / todo.requests.total) * 100 : 0}%` }} />
                </div>
              </div>
              <div className="card">
                <div className="muted small">制作物</div>
                <div>
                  <strong>
                    {todo.deliverables.approved}/{todo.deliverables.total}
                  </strong>{' '}
                  承認済み
                </div>
                <div className="progress ok" aria-hidden>
                  <div style={{ width: `${todo.deliverables.total ? (todo.deliverables.approved / todo.deliverables.total) * 100 : 0}%` }} />
                </div>
              </div>
            </div>
            {project.description && (
              <div className="card flat">
                <h3>案件について</h3>
                <p className="pre small">{project.description}</p>
              </div>
            )}
          </div>
        );
      }}
    </Page>
  );
}

interface RequestDto {
  id: string;
  title: string;
  description: string;
  kind: 'file' | 'text' | 'url' | 'choice' | 'check';
  required: boolean;
  dueDate: string | null;
  choices: string[];
  status: string;
  statusLabel: string;
  answer: { text: string | null; url: string | null; choice: string | null; checked: boolean | null };
  files: { id: string; name: string; size: number; url: string; downloadUrl: string; previewKind: string; uploaderType: string }[];
  returnReason: string;
}

function Requests({ pid }: { pid: string }) {
  useTitle('資料の提出');
  const st = useApi<{ requests: RequestDto[] }>(`/api/portal/projects/${pid}/requests`, [pid]);
  return (
    <Page state={st}>
      {(d) => {
        const done = d.requests.filter((r) => r.status === 'submitted' || r.status === 'accepted').length;
        return (
          <div className="stack">
            <h1>資料の提出</h1>
            <div className="card">
              <div className="row between">
                <strong>
                  {done}/{d.requests.length} 提出済み
                </strong>
                <span className="muted small">「確認済み」は担当者が内容を確認したものです</span>
              </div>
              <div className="progress ok">
                <div style={{ width: `${d.requests.length ? (done / d.requests.length) * 100 : 0}%` }} />
              </div>
            </div>
            {d.requests.length === 0 && <Empty>現在お願いしている資料はありません。</Empty>}
            {d.requests.map((r) => (
              <RequestCard key={r.id} pid={pid} r={r} onChanged={st.reload} />
            ))}
          </div>
        );
      }}
    </Page>
  );
}

function RequestCard({ pid, r, onChanged }: { pid: string; r: RequestDto; onChanged: () => void }) {
  const open = r.status === 'pending' || r.status === 'returned';
  const [text, setText] = useState(r.answer.text ?? '');
  const [url, setUrl] = useState(r.answer.url ?? '');
  const [choice, setChoice] = useState(r.answer.choice ?? '');
  const [checked, setChecked] = useState(!!r.answer.checked);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  async function submit() {
    setError(null);
    try {
      await post(`/api/portal/projects/${pid}/requests/${r.id}/submit`, { text: text || undefined, url: url || undefined, choice: choice || undefined, checked });
      toast(`「${r.title}」を提出しました`);
      onChanged();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }
  const myFiles = r.files;
  return (
    <div className={`card ${r.status === 'returned' ? 'danger' : ''}`} data-testid={`request-${r.title}`}>
      <div className="row between">
        <h3 style={{ margin: 0 }}>
          {r.title}
          {!r.required && <span className="muted small">（任意）</span>}
        </h3>
        <StatusBadge status={r.status} label={r.statusLabel} />
      </div>
      {r.description && <p className="small pre" style={{ marginTop: 4 }}>{r.description}</p>}
      {r.dueDate && (
        <div className="small" style={isOverdue(r.dueDate) && open ? { color: 'var(--danger)' } : { color: 'var(--muted)' }}>
          期限: {fmtDate(r.dueDate)}
        </div>
      )}
      {r.status === 'returned' && r.returnReason && <div className="alert error small">再提出のお願い: {r.returnReason}</div>}
      {myFiles.length > 0 && (
        <div className="small" style={{ marginTop: 8 }}>
          {myFiles.map((f) => (
            <div key={f.id} className="row between" style={{ padding: '4px 0' }}>
              <a href={f.downloadUrl}>{f.name}</a>
              <span className="row">
                <span className="muted">{fmtSize(f.size)}</span>
                {open && f.uploaderType === 'client' && (
                  <AsyncButton
                    className="btn ghost small"
                    onClick={async () => {
                      if (!confirm(`「${f.name}」を取り下げますか？`)) return;
                      await post(`/api/portal/projects/${pid}/files/${f.id}/withdraw`).catch((e) => toast((e as ApiError).message));
                      onChanged();
                    }}
                  >
                    取り下げ
                  </AsyncButton>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {!open && (
        <div className="small muted" style={{ marginTop: 8 }}>
          {r.answer.text && <div className="pre">回答: {r.answer.text}</div>}
          {r.answer.url && <div>URL: {r.answer.url}</div>}
          {r.answer.choice && <div>選択: {r.answer.choice}</div>}
          {r.answer.checked && <div>✓ 確認しました</div>}
        </div>
      )}
      {open && (
        <div style={{ marginTop: 10 }}>
          {r.kind === 'file' && (
            <>
              <Uploader initUrl={`/api/portal/projects/${pid}/uploads`} extra={{ requestId: r.id }} onUploaded={onChanged} />
              <label className="field" style={{ marginTop: 10 }}>
                <span>補足（任意）</span>
                <input type="text" value={text} onChange={(e) => setText(e.target.value)} />
              </label>
            </>
          )}
          {r.kind === 'text' && (
            <label className="field">
              <span>回答</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} />
            </label>
          )}
          {r.kind === 'url' && (
            <label className="field">
              <span>URL</span>
              <input type="url" inputMode="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
          )}
          {r.kind === 'choice' && (
            <fieldset style={{ border: 0, padding: 0, margin: '0 0 10px' }}>
              <legend className="small" style={{ fontWeight: 600 }}>選択してください</legend>
              {r.choices.map((c) => (
                <label key={c} className="check">
                  <input type="radio" name={`ch-${r.id}`} checked={choice === c} onChange={() => setChoice(c)} />
                  {c}
                </label>
              ))}
            </fieldset>
          )}
          {r.kind === 'check' && (
            <label className="check">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              内容を確認しました
            </label>
          )}
          {error && <div className="alert error">{error}</div>}
          <AsyncButton className="btn primary block" onClick={submit} disabled={r.kind === 'file' && myFiles.length === 0}>
            {r.status === 'returned' ? '再提出する' : 'この内容で提出する'}
          </AsyncButton>
          {r.kind === 'file' && myFiles.length === 0 && <div className="muted small">ファイルを追加すると提出できます</div>}
        </div>
      )}
    </div>
  );
}

function ReviewList({ pid }: { pid: string }) {
  useTitle('制作物の確認');
  const st = useApi<{ deliverables: { id: string; title: string; status: string; statusLabel: string; latestVersionNumber: number; thumbUrl: string | null; submittedAt: string; openCommentCount: number }[] }>(
    `/api/portal/projects/${pid}/deliverables`,
    [pid],
  );
  return (
    <Page state={st}>
      {(d) => (
        <div className="stack">
          <h1>制作物の確認</h1>
          {d.deliverables.length === 0 && <Empty>ご確認いただく制作物はまだありません。</Empty>}
          <div className="list">
            {d.deliverables.map((x) => (
              <Link key={x.id} to={`/portal/p/${pid}/review/${x.id}`} className="item">
                {x.thumbUrl ? (
                  <img src={x.thumbUrl} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8 }} loading="lazy" />
                ) : (
                  <span style={{ fontSize: '1.8rem' }}>📄</span>
                )}
                <div className="grow">
                  <div className="title">
                    {x.title} <span className="badge">v{x.latestVersionNumber}</span>
                  </div>
                  <div className="small muted">提出 {fmtDate(x.submittedAt)}</div>
                </div>
                <StatusBadge status={x.status} label={x.status === 'in_review' ? 'ご確認ください' : x.statusLabel} />
              </Link>
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}

function ReviewPage({ pid }: { pid: string }) {
  const { did } = useParams();
  const st = useApi<{ deliverable: DeliverableDto; comments: Record<string, CommentDto[]> }>(`/api/portal/projects/${pid}/deliverables/${did}`, [pid, did]);
  const [sel, setSel] = useState<string | null>(null);
  const [approveFor, setApproveFor] = useState<VersionDto | null>(null);
  const [changeFor, setChangeFor] = useState<VersionDto | null>(null);
  const [revoke, setRevoke] = useState<VersionDto | null>(null);
  useTitle(st.data?.deliverable.title ?? '確認');
  const base = `/api/portal/projects/${pid}`;
  return (
    <Page state={st}>
      {(d) => {
        const selected = sel && d.deliverable.versions.some((v) => v.id === sel) ? sel : d.deliverable.versions[0].id;
        return (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <Link to={`/portal/p/${pid}/review`} className="btn ghost small">
                ‹ 一覧へ
              </Link>
            </div>
            <ReviewPanel
              base={base}
              deliverable={d.deliverable}
              comments={d.comments}
              selectedId={selected}
              onSelect={setSel}
              onChanged={st.reload}
              actions={(v) =>
                v.isLatest ? (
                  <div className="card">
                    {(v.status === 'in_review' || v.status === 'changes_requested') && (
                      <>
                        <p className="small" style={{ marginBottom: 10 }}>
                          {v.status === 'changes_requested'
                            ? '修正をご依頼いただいています。新しい版が届くまでお待ちください（この版で問題なければ承認もできます）。'
                            : '内容をご確認のうえ、どちらかを選んでください。'}
                        </p>
                        <div className="grid cols-2">
                          <button className="btn ok block" onClick={() => setApproveFor(v)} data-testid="approve-open">
                            ✓ この内容で承認
                          </button>
                          <button className="btn block" onClick={() => setChangeFor(v)} data-testid="change-open">
                            ✎ 修正を依頼
                          </button>
                        </div>
                      </>
                    )}
                    {v.status === 'approved' && v.approval && (
                      <div>
                        <div className="alert ok" style={{ marginBottom: 8 }}>
                          ✓ {fmtDate(v.approval.approvedAt)} に v{v.versionNumber} を承認いただきました。
                        </div>
                        <button className="btn small ghost" onClick={() => setRevoke(v)}>
                          承認を取り消す
                        </button>
                      </div>
                    )}
                  </div>
                ) : null
              }
            />
            {approveFor && <ApproveModal pid={pid} deliverable={d.deliverable} version={approveFor} onClose={() => setApproveFor(null)} onDone={() => (setApproveFor(null), st.reload())} />}
            {changeFor && (
              <ChangeModal
                pid={pid}
                version={changeFor}
                title={d.deliverable.title}
                pinCount={(d.comments[changeFor.id] ?? []).filter((c) => c.pin && !c.resolved && !c.deleted).length}
                onClose={() => setChangeFor(null)}
                onDone={() => (setChangeFor(null), st.reload())}
              />
            )}
            {revoke && revoke.approval && <RevokeModal pid={pid} approvalId={revoke.approval.id} onClose={() => setRevoke(null)} onDone={() => (setRevoke(null), st.reload())} />}
          </>
        );
      }}
    </Page>
  );
}

function ApproveModal({ pid, deliverable, version, onClose, onDone }: { pid: string; deliverable: DeliverableDto; version: VersionDto; onClose: () => void; onDone: () => void }) {
  // ダイアログごとに1つの冪等キー（二重クリック・再送でも承認は1件）
  const [key] = useState(newIdempotencyKey);
  const [confirmed, setConfirmed] = useState(false);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const online = useOnline();
  async function approve() {
    setError(null);
    try {
      await post(`/api/portal/projects/${pid}/versions/${version.id}/approve`, { idempotencyKey: key, expectedVersionNumber: version.versionNumber, comment, confirm: true });
      toast(`${deliverable.title} v${version.versionNumber} を承認しました`);
      onDone();
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'stale_version' ? `${err.message}。画面を更新して最新版をご確認ください。` : err.message);
    }
  }
  return (
    <Modal title="承認の確認" onClose={onClose}>
      <div className="card flat" style={{ marginBottom: 12 }}>
        <div className="muted small">対象の制作物</div>
        <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{deliverable.title}</div>
        <div>
          バージョン: <strong>v{version.versionNumber}</strong>（最新版）
        </div>
        <div className="small muted">提出日時: {fmtDate(version.submittedAt)}</div>
        <div className="small muted">ファイル: {version.file.name}</div>
      </div>
      <label className="check">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="approve-check" />
        <span>
          <strong>この版（v{version.versionNumber}）を承認します</strong>
        </span>
      </label>
      <label className="field">
        <span>コメント（任意）</span>
        <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <p className="muted small">
        承認後にこの版のファイルが差し替えられることはありません。変更がある場合は新しい版として改めてご確認をお願いします。
        ※この承認は制作上の確認記録であり、電子契約・電子署名ではありません。
      </p>
      {error && <div className="alert error">{error}</div>}
      <AsyncButton className="btn ok block" onClick={approve} disabled={!confirmed || !online}>
        承認する
      </AsyncButton>
    </Modal>
  );
}

function ChangeModal({ pid, version, title, pinCount, onClose, onDone }: { pid: string; version: VersionDto; title: string; pinCount: number; onClose: () => void; onDone: () => void }) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  return (
    <Modal title="修正を依頼" onClose={onClose}>
      <p className="small">
        対象: <strong>{title} v{version.versionNumber}</strong>
      </p>
      {pinCount > 0 && <div className="alert small">画像上のピンコメント（未解決 {pinCount}件）も一緒に担当者へ伝わります。</div>}
      <label className="field">
        <span>修正してほしい内容</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="例: 文字をもう少し大きく、ロゴを右下へ" data-testid="change-body" />
      </label>
      {error && <div className="alert error">{error}</div>}
      <AsyncButton
        className="btn primary block"
        onClick={async () => {
          setError(null);
          try {
            await post(`/api/portal/projects/${pid}/versions/${version.id}/change-request`, { body });
            toast('修正を依頼しました');
            onDone();
          } catch (e) {
            setError((e as ApiError).message);
          }
        }}
      >
        修正を依頼する
      </AsyncButton>
    </Modal>
  );
}

function RevokeModal({ pid, approvalId, onClose, onDone }: { pid: string; approvalId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="承認を取り消す" onClose={onClose}>
      <p className="small">取り消した記録は履歴に残ります。取消後は再度ご確認・承認が必要です。</p>
      <label className="field">
        <span>取消の理由</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <div className="alert error">{error}</div>}
      <AsyncButton
        className="btn danger block"
        onClick={async () => {
          try {
            await post(`/api/portal/projects/${pid}/approvals/${approvalId}/revoke`, { reason });
            onDone();
          } catch (e) {
            setError((e as ApiError).message);
          }
        }}
      >
        承認を取り消す
      </AsyncButton>
    </Modal>
  );
}

function Deliveries({ pid }: { pid: string }) {
  useTitle('納品物');
  const st = useApi<{ deliveries: { id: string; title: string; description: string; notice: string; expiresAt: string | null; expired: boolean; publishedAt: string; zipUrl: string; items: { id: string; label: string; file: { name: string; size: number; downloadUrl: string; url: string; previewKind: string } }[] }[] }>(
    `/api/portal/projects/${pid}/deliveries`,
    [pid],
  );
  return (
    <Page state={st}>
      {(d) => (
        <div className="stack">
          <h1>納品物</h1>
          {d.deliveries.length === 0 && <Empty>納品物はまだありません。承認いただいた制作物は、最終納品としてここからお受け取りいただけます。</Empty>}
          {d.deliveries.map((x) => (
            <div key={x.id} className="card" data-testid="delivery">
              <div className="row between">
                <h2 style={{ margin: 0 }}>{x.title}</h2>
                <span className="muted small">{fmtDate(x.publishedAt)}</span>
              </div>
              {x.description && <p className="pre small">{x.description}</p>}
              {x.notice && <div className="alert warn small pre">{x.notice}</div>}
              {x.expiresAt && <div className={`small ${x.expired ? '' : 'muted'}`}>ダウンロード期限: {fmtDate(x.expiresAt)}{x.expired && '（期限切れ。担当者にご連絡ください）'}</div>}
              {!x.expired && (
                <>
                  <a className="btn primary block" href={x.zipUrl} style={{ margin: '12px 0' }} data-testid="zip-download">
                    ⬇ まとめてダウンロード（ZIP）
                  </a>
                  <div className="muted small">ZIPが開けない場合や時間がかかる場合は、下から1つずつダウンロードできます。途中で失敗した場合はもう一度押してください。</div>
                  <div className="list" style={{ marginTop: 10 }}>
                    {x.items.map((i) => (
                      <a key={i.id} href={i.file.downloadUrl} className="item">
                        {i.file.previewKind === 'image' ? (
                          <img src={i.file.url} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6 }} loading="lazy" />
                        ) : (
                          <span style={{ fontSize: '1.5rem' }}>📄</span>
                        )}
                        <div className="grow">
                          <div className="title">{i.label}</div>
                          <div className="muted small">
                            {i.file.name} ・ {fmtSize(i.file.size)}
                          </div>
                        </div>
                        <span>⬇</span>
                      </a>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}

function Activity({ pid }: { pid: string }) {
  useTitle('履歴');
  const st = useApi<{ events: { seq: number; actorName: string; actorType: string; summary: string; at: string }[] }>(`/api/portal/projects/${pid}/activity`, [pid]);
  return (
    <Page state={st}>
      {(d) => (
        <div>
          <h1>最近の更新</h1>
          {d.events.length === 0 ? (
            <Empty>まだ履歴はありません。</Empty>
          ) : (
            <ul className="timeline">
              {d.events.map((e) => (
                <li key={e.seq}>
                  <div>{e.summary}</div>
                  <div className="muted small">
                    {fmtDate(e.at)} {e.actorName}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Page>
  );
}

function Notifications({ onRead }: { onRead: () => void }) {
  useTitle('お知らせ');
  const st = useApi<{ notifications: { id: string; title: string; body: string; link: string; createdAt: string; read: boolean }[] }>('/api/portal/notifications');
  const settings = useApi<{ emailEnabled: boolean; mailAvailable: boolean }>('/api/portal/notification-settings');
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>お知らせ</h1>
        <AsyncButton
          className="btn small"
          onClick={async () => {
            await post('/api/portal/notifications/read', { all: true });
            onRead();
            st.reload();
          }}
        >
          すべて既読
        </AsyncButton>
      </div>
      <ErrorBox error={st.error} />
      {!st.data ? (
        <Loading />
      ) : st.data.notifications.length === 0 ? (
        <Empty>お知らせはありません。</Empty>
      ) : (
        <div className="list">
          {st.data.notifications.map((n) => (
            <Link key={n.id} to={n.link || '/portal'} className="item" style={n.read ? { opacity: 0.7 } : { borderColor: 'var(--primary)' }}>
              <div className="grow">
                <div className="title">{n.title}</div>
                {n.body && <div className="small muted pre">{n.body}</div>}
                <div className="small muted">{fmtDate(n.createdAt)}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
      {settings.data?.mailAvailable && (
        <label className="check">
          <input
            type="checkbox"
            checked={settings.data.emailEnabled}
            onChange={async (e) => {
              await api('PUT', '/api/portal/notification-settings', { emailEnabled: e.target.checked }).catch(() => undefined);
              settings.reload();
            }}
          />
          お知らせをメールでも受け取る（ファイルは添付されません）
        </label>
      )}
    </div>
  );
}

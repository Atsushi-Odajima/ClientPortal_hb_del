import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, del, get, patch, post } from '../../api';
import { AsyncButton, Empty, Modal, Page, StatusBadge, fmtDate, fmtSize, useApi, useTitle, useToast } from '../../components/ui';
import { Uploader } from '../../components/Uploader';
import { useMe } from './OperatorApp';
import { PROJECT_STATUSES, PROJECT_STATUS_CLIENT_LABEL, PROJECT_STATUS_LABEL, REQUEST_KIND_LABEL, type ProjectStatus } from '../../../../shared/labels';

interface FileDto {
  id: string;
  name: string;
  size: number;
  url: string;
  downloadUrl: string;
  previewKind: string;
  uploaderType: string;
  createdAt: string;
}
interface RequestDto {
  id: string;
  title: string;
  description: string;
  kind: keyof typeof REQUEST_KIND_LABEL;
  required: boolean;
  dueDate: string | null;
  choices: string[];
  status: string;
  statusLabel: string;
  answer: { text: string | null; url: string | null; choice: string | null; checked: boolean | null };
  files: FileDto[];
  submittedAt: string | null;
  returnReason: string;
  internalMemo: string;
}
interface Detail {
  project: {
    id: string;
    name: string;
    description: string;
    startDate: string | null;
    dueDate: string | null;
    clientGuidance: string;
    clientStatusLabel: string;
    customClientStatusLabel: string;
    status: ProjectStatus;
    statusLabel: string;
    internalMemo: string;
    portalStatus: 'draft' | 'published' | 'closed';
    categories: string[];
    checklist: string[];
    isSample: boolean;
    archived: boolean;
  };
  client: { id: string; companyName: string; contactName: string; email: string; status: string };
  requests: RequestDto[];
  deliverables: { id: string; title: string; category: string; status: string; statusLabel: string; latestVersionNumber: number; versions: { id: string; file: FileDto; openCommentCount: number; submittedAt: string }[] }[];
  deliveries: DeliveryDto[];
  internalFiles: FileDto[];
  access: { id: string; status: string; client: { id: string; companyName: string; email: string }; invites: { id: string; expiresAt: string; revokedAt: string | null; useCount: number; lastUsedAt: string | null; createdAt: string; active: boolean }[] }[];
  statusHistory: { from: string | null; toLabel: string; byType: string; note: string; at: string }[];
}
interface DeliveryDto {
  id: string;
  title: string;
  description: string;
  notice: string;
  expiresAt: string | null;
  expired: boolean;
  status: 'draft' | 'published' | 'withdrawn';
  publishedAt: string | null;
  zipUrl: string;
  items: { id: string; label: string; versionId: string | null; file: FileDto }[];
}

const TABS = [
  ['overview', '概要'],
  ['requests', '資料'],
  ['deliverables', '制作物'],
  ['deliveries', '納品'],
  ['share', '共有・招待'],
  ['files', '作業ファイル'],
  ['activity', '履歴'],
] as const;

export function ProjectDetail() {
  const { pid } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'overview';
  const st = useApi<Detail>(`/api/app/projects/${pid}`, [pid]);
  useTitle(st.data?.project.name ?? '案件');
  return (
    <Page state={st}>
      {(d) => (
        <div>
          <div className="muted small">
            <Link to="/app/projects">案件</Link> ／ <Link to={`/app/clients/${d.client.id}`}>{d.client.companyName}</Link>
          </div>
          <div className="row between" style={{ margin: '4px 0 12px' }}>
            <h1 style={{ margin: 0 }}>
              {d.project.name} {d.project.isSample && <span className="badge info">サンプル</span>} {d.project.archived && <span className="badge">アーカイブ</span>}
            </h1>
            <div className="row">
              <span className="badge info">{d.project.statusLabel}</span>
              <span className={`badge ${d.project.portalStatus === 'published' ? 'ok' : ''}`}>ポータル: {{ draft: '非公開', published: '公開中', closed: '終了' }[d.project.portalStatus]}</span>
            </div>
          </div>
          <nav className="tabs" role="tablist">
            {TABS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setSp({ tab: k }, { replace: true })}>
                {label}
                {k === 'requests' && d.requests.some((r) => r.status === 'submitted') && <span className="badge warn" style={{ marginLeft: 4 }}>{d.requests.filter((r) => r.status === 'submitted').length}</span>}
              </button>
            ))}
          </nav>
          {tab === 'overview' && <Overview d={d} reload={st.reload} />}
          {tab === 'requests' && <RequestsTab d={d} reload={st.reload} />}
          {tab === 'deliverables' && <DeliverablesTab d={d} reload={st.reload} />}
          {tab === 'deliveries' && <DeliveriesTab d={d} reload={st.reload} />}
          {tab === 'share' && <ShareTab d={d} reload={st.reload} />}
          {tab === 'files' && <FilesTab d={d} reload={st.reload} />}
          {tab === 'activity' && <ActivityTab d={d} />}
        </div>
      )}
    </Page>
  );
}

function Overview({ d, reload }: { d: Detail; reload: () => void }) {
  const p = d.project;
  const toast = useToast();
  const nav = useNavigate();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({
    name: p.name,
    description: p.description,
    startDate: p.startDate ?? '',
    dueDate: p.dueDate ?? '',
    clientGuidance: p.clientGuidance,
    internalMemo: p.internalMemo,
    clientStatusLabel: p.customClientStatusLabel,
    checklist: p.checklist.join('\n'),
    categories: p.categories.join('\n'),
  });
  const [status, setStatus] = useState<ProjectStatus>(p.status);
  const [note, setNote] = useState('');
  const [delName, setDelName] = useState('');
  const [showDel, setShowDel] = useState(false);
  return (
    <div className="stack">
      <div className="card">
        <h3>案件の状態</h3>
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)} style={{ maxWidth: 220 }} aria-label="状態">
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {PROJECT_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <input type="text" placeholder="メモ（任意・内部）" value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 260 }} />
          <AsyncButton
            className="btn primary"
            disabled={status === p.status}
            onClick={async () => {
              await post(`/api/app/projects/${p.id}/status`, { status, note });
              setNote('');
              toast('状態を変更しました');
              reload();
            }}
          >
            変更
          </AsyncButton>
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>
          顧客には「{p.clientStatusLabel}」と表示されます（{p.customClientStatusLabel ? '個別設定' : `既定: ${PROJECT_STATUS_CLIENT_LABEL[p.status]}`}）。提出・修正依頼・承認・納品に応じて自動で更新されます。
        </div>
      </div>
      <div className="card">
        <div className="row between">
          <h3 style={{ margin: 0 }}>基本情報</h3>
          <button className="btn small" onClick={() => setEdit(!edit)}>
            {edit ? 'キャンセル' : '編集'}
          </button>
        </div>
        {!edit ? (
          <div className="small" style={{ marginTop: 8 }}>
            <p>
              顧客: {d.client.companyName}（{d.client.contactName} / {d.client.email}）
            </p>
            <p>
              期間: {fmtDate(p.startDate) || '未設定'} 〜 {fmtDate(p.dueDate) || '未設定'}
            </p>
            {p.description && <p className="pre">説明: {p.description}</p>}
            {p.clientGuidance && <p className="pre">顧客向け案内: {p.clientGuidance}</p>}
            <div className="alert warn pre">🔒 内部メモ（顧客には表示されません）: {p.internalMemo || 'なし'}</div>
            {p.checklist.length > 0 && <p>標準確認項目: {p.checklist.join('、')}</p>}
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <label className="field">
              <span>案件名</span>
              <input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </label>
            <div className="grid cols-2">
              <label className="field">
                <span>開始日</span>
                <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
              </label>
              <label className="field">
                <span>予定納期</span>
                <input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span>説明（顧客にも表示）</span>
              <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            </label>
            <label className="field">
              <span>顧客向け案内（ポータル上部に表示）</span>
              <textarea value={f.clientGuidance} onChange={(e) => setF({ ...f, clientGuidance: e.target.value })} />
            </label>
            <label className="field">
              <span>顧客に表示する状況（空欄なら状態に応じた既定表示）</span>
              <input type="text" value={f.clientStatusLabel} onChange={(e) => setF({ ...f, clientStatusLabel: e.target.value })} />
            </label>
            <label className="field">
              <span>🔒 内部メモ（顧客には表示されません）</span>
              <textarea value={f.internalMemo} onChange={(e) => setF({ ...f, internalMemo: e.target.value })} />
            </label>
            <label className="field">
              <span>標準確認項目（1行1項目。制作物提出時の初期値）</span>
              <textarea value={f.checklist} onChange={(e) => setF({ ...f, checklist: e.target.value })} />
            </label>
            <label className="field">
              <span>制作物カテゴリ（1行1項目）</span>
              <textarea value={f.categories} onChange={(e) => setF({ ...f, categories: e.target.value })} />
            </label>
            <AsyncButton
              className="btn primary"
              onClick={async () => {
                try {
                  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
                  await patch(`/api/app/projects/${p.id}`, {
                    ...f,
                    startDate: f.startDate || null,
                    dueDate: f.dueDate || null,
                    checklist: lines(f.checklist),
                    categories: lines(f.categories),
                  });
                  setEdit(false);
                  reload();
                } catch (e) {
                  toast((e as ApiError).message);
                }
              }}
            >
              保存
            </AsyncButton>
          </div>
        )}
      </div>
      <div className="card flat">
        <h3>その他の操作</h3>
        <div className="row">
          <a className="btn small" href={`/app/projects/${p.id}?tab=share`} onClick={(e) => (e.preventDefault(), nav(`?tab=share`))}>
            顧客を招待
          </a>
          <AsyncButton
            className="btn small"
            onClick={async () => {
              const name = prompt('テンプレート名', `${p.name} のテンプレート`);
              if (!name) return;
              await post(`/api/app/projects/${p.id}/save-as-template`, { name });
              toast('テンプレートとして保存しました');
            }}
          >
            テンプレートとして保存
          </AsyncButton>
          <AsyncButton
            className="btn small"
            onClick={async () => {
              await post(`/api/app/projects/${p.id}/archive`, { archived: !p.archived });
              toast(p.archived ? 'アーカイブを解除しました' : 'アーカイブしました（顧客はアクセスできなくなります）');
              reload();
            }}
          >
            {p.archived ? 'アーカイブ解除' : 'アーカイブ'}
          </AsyncButton>
          <button className="btn small danger" onClick={() => setShowDel(true)}>
            削除
          </button>
        </div>
      </div>
      {showDel && (
        <Modal title="案件を完全に削除" onClose={() => setShowDel(false)}>
          <div className="alert error small">
            案件のデータ（資料・制作物・コメント・承認・納品）とファイル実体を削除します。元に戻せません。監査ログ（操作の記録）は残ります。バックアップ内のデータは保持期間が過ぎるまで残ります。
            通常は「アーカイブ」をおすすめします。
          </div>
          <label className="field">
            <span>確認のため案件名「{p.name}」を入力</span>
            <input type="text" value={delName} onChange={(e) => setDelName(e.target.value)} />
          </label>
          <AsyncButton
            className="btn danger block"
            disabled={delName !== p.name}
            onClick={async () => {
              try {
                await del(`/api/app/projects/${p.id}`, { confirmName: delName });
                nav('/app/projects');
              } catch (e) {
                toast((e as ApiError).message);
              }
            }}
          >
            完全に削除する
          </AsyncButton>
        </Modal>
      )}
      <StatusHistory d={d} />
    </div>
  );
}

function StatusHistory({ d }: { d: Detail }) {
  if (d.statusHistory.length === 0) return null;
  return (
    <div className="card flat">
      <h3>状態の履歴</h3>
      <ul className="timeline">
        {d.statusHistory.map((h, i) => (
          <li key={i} className="small">
            {h.toLabel} <span className="muted">{h.byType === 'system' ? '（自動）' : ''}</span> {h.note && `— ${h.note}`}
            <div className="muted">{fmtDate(h.at)}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const emptyReq = { title: '', description: '', kind: 'file' as RequestDto['kind'], required: true, dueDate: '', choices: '', internalMemo: '' };

function RequestsTab({ d, reload }: { d: Detail; reload: () => void }) {
  const [form, setForm] = useState<typeof emptyReq | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [returning, setReturning] = useState<RequestDto | null>(null);
  const [reason, setReason] = useState('');
  const toast = useToast();
  const pid = d.project.id;
  const done = d.requests.filter((r) => r.status === 'submitted' || r.status === 'accepted').length;
  async function save() {
    if (!form) return;
    const body = {
      title: form.title,
      description: form.description,
      kind: form.kind,
      required: form.required,
      dueDate: form.dueDate || null,
      choices: form.choices.split('\n').map((x) => x.trim()).filter(Boolean),
      internalMemo: form.internalMemo,
    };
    try {
      if (editId) await patch(`/api/app/projects/${pid}/requests/${editId}`, body);
      else await post(`/api/app/projects/${pid}/requests`, body);
      setForm(null);
      setEditId(null);
      reload();
    } catch (e) {
      toast((e as ApiError).message);
    }
  }
  return (
    <div className="stack">
      <div className="row between">
        <div>
          顧客提出: <strong>{done}/{d.requests.length}</strong>（確認済み {d.requests.filter((r) => r.status === 'accepted').length}）
        </div>
        <button className="btn primary" onClick={() => (setForm({ ...emptyReq }), setEditId(null))}>
          ＋ 資料リクエスト
        </button>
      </div>
      {d.requests.length === 0 && <Empty>顧客に提出してほしい資料・回答を登録してください（ロゴ、写真、掲載文、参考URLなど）。</Empty>}
      {d.requests.map((r) => (
        <div key={r.id} className={`card ${r.status === 'submitted' ? 'warn' : ''}`} data-testid={`op-request-${r.title}`}>
          <div className="row between">
            <h3 style={{ margin: 0 }}>
              {r.title} <span className="badge">{REQUEST_KIND_LABEL[r.kind]}</span> {!r.required && <span className="muted small">任意</span>}
            </h3>
            <StatusBadge status={r.status} label={r.statusLabel} />
          </div>
          {r.description && <p className="small pre">{r.description}</p>}
          <div className="muted small">
            {r.dueDate && <>期限 {fmtDate(r.dueDate)} ／ </>}
            {r.submittedAt && <>提出 {fmtDate(r.submittedAt)}</>}
          </div>
          {r.internalMemo && <div className="small muted">🔒 {r.internalMemo}</div>}
          {r.files.length > 0 && (
            <div className="list" style={{ marginTop: 8 }}>
              {r.files.map((f) => (
                <div key={f.id} className="item" style={{ padding: 8 }}>
                  {f.previewKind === 'image' ? <img src={f.url} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6 }} loading="lazy" /> : <span>📄</span>}
                  <div className="grow small">
                    <a href={f.url} target="_blank" rel="noreferrer">
                      {f.name}
                    </a>
                    <div className="muted">
                      {fmtSize(f.size)} ・ {f.uploaderType === 'client' ? '顧客' : '自分'} ・ {fmtDate(f.createdAt)}
                    </div>
                  </div>
                  <a className="btn small" href={f.downloadUrl}>
                    ⬇
                  </a>
                </div>
              ))}
            </div>
          )}
          {(r.answer.text || r.answer.url || r.answer.choice || r.answer.checked) && (
            <div className="card flat small" style={{ marginTop: 8 }}>
              {r.answer.text && <div className="pre">回答: {r.answer.text}</div>}
              {r.answer.url && (
                <div>
                  URL:{' '}
                  <a href={r.answer.url} target="_blank" rel="noreferrer noopener">
                    {r.answer.url}
                  </a>
                </div>
              )}
              {r.answer.choice && <div>選択: {r.answer.choice}</div>}
              {r.answer.checked && <div>✓ 確認済みチェック</div>}
            </div>
          )}
          {r.status === 'returned' && <div className="small" style={{ color: 'var(--danger)' }}>差戻し理由: {r.returnReason}</div>}
          <div className="row" style={{ marginTop: 10 }}>
            {r.status === 'submitted' && (
              <>
                <AsyncButton className="btn ok small" onClick={async () => (await post(`/api/app/projects/${pid}/requests/${r.id}/review`, { decision: 'accept' }), reload())}>
                  ✓ 確認済みにする
                </AsyncButton>
                <button className="btn small" onClick={() => (setReturning(r), setReason(''))}>
                  差戻し
                </button>
              </>
            )}
            {r.status === 'accepted' && (
              <button className="btn small ghost" onClick={() => (setReturning(r), setReason(''))}>
                差戻しに変更
              </button>
            )}
            <button
              className="btn small ghost"
              onClick={() => {
                setEditId(r.id);
                setForm({ title: r.title, description: r.description, kind: r.kind, required: r.required, dueDate: r.dueDate ?? '', choices: r.choices.join('\n'), internalMemo: r.internalMemo });
              }}
            >
              編集
            </button>
            {r.status === 'pending' && r.files.length === 0 && (
              <AsyncButton
                className="btn small ghost"
                onClick={async () => {
                  if (!confirm('削除しますか？')) return;
                  await del(`/api/app/projects/${pid}/requests/${r.id}`).catch((e) => toast((e as ApiError).message));
                  reload();
                }}
              >
                削除
              </AsyncButton>
            )}
          </div>
        </div>
      ))}
      {form && (
        <Modal title={editId ? '資料リクエストを編集' : '資料リクエストを追加'} onClose={() => setForm(null)}>
          <label className="field">
            <span>タイトル</span>
            <input type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="例: ロゴデータ" />
          </label>
          <label className="field">
            <span>種類</span>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as RequestDto['kind'] })}>
              {Object.entries(REQUEST_KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {form.kind === 'choice' && (
            <label className="field">
              <span>選択肢（1行に1つ）</span>
              <textarea value={form.choices} onChange={(e) => setForm({ ...form, choices: e.target.value })} />
            </label>
          )}
          <label className="field">
            <span>説明（顧客に表示）</span>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <div className="grid cols-2">
            <label className="field">
              <span>期限</span>
              <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} />
              必須
            </label>
          </div>
          <label className="field">
            <span>🔒 内部メモ（顧客に非表示）</span>
            <input type="text" value={form.internalMemo} onChange={(e) => setForm({ ...form, internalMemo: e.target.value })} />
          </label>
          <AsyncButton className="btn primary block" onClick={save}>
            保存
          </AsyncButton>
        </Modal>
      )}
      {returning && (
        <Modal title={`「${returning.title}」を差戻し`} onClose={() => setReturning(null)}>
          <label className="field">
            <span>差戻し理由（顧客に表示されます）</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <AsyncButton
            className="btn danger block"
            onClick={async () => {
              try {
                await post(`/api/app/projects/${pid}/requests/${returning.id}/review`, { decision: 'return', reason });
                setReturning(null);
                reload();
              } catch (e) {
                toast((e as ApiError).message);
              }
            }}
          >
            差戻す
          </AsyncButton>
        </Modal>
      )}
    </div>
  );
}

function DeliverablesTab({ d, reload }: { d: Detail; reload: () => void }) {
  const [form, setForm] = useState<{ title: string; category: string; description: string } | null>(null);
  const toast = useToast();
  const nav = useNavigate();
  return (
    <div className="stack">
      <div className="row between">
        <div className="muted small">制作物ごとに v1, v2, v3… と版を重ねます。旧版は削除されません。</div>
        <button className="btn primary" onClick={() => setForm({ title: '', category: d.project.categories[0] ?? '', description: '' })}>
          ＋ 制作物
        </button>
      </div>
      {d.deliverables.length === 0 && <Empty>制作物を追加し、ファイルを提出すると顧客の確認待ちになります。</Empty>}
      <div className="list">
        {d.deliverables.map((x) => {
          const latest = x.versions[0];
          return (
            <Link key={x.id} to={`/app/projects/${d.project.id}/deliverables/${x.id}`} className="item">
              {latest?.file.previewKind === 'image' ? (
                <img src={latest.file.url} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8 }} loading="lazy" />
              ) : (
                <span style={{ fontSize: '1.6rem' }}>{latest ? '📄' : '➕'}</span>
              )}
              <div className="grow">
                <div className="title">
                  {x.title} {x.latestVersionNumber > 0 && <span className="badge">v{x.latestVersionNumber}</span>}
                </div>
                <div className="muted small">
                  {x.category}
                  {latest && <> ／ 提出 {fmtDate(latest.submittedAt)}</>}
                  {latest && latest.openCommentCount > 0 && <> ／ 未解決コメント {latest.openCommentCount}</>}
                </div>
              </div>
              <StatusBadge status={x.status} label={x.statusLabel} />
            </Link>
          );
        })}
      </div>
      {form && (
        <Modal title="制作物を追加" onClose={() => setForm(null)}>
          <label className="field">
            <span>制作物名</span>
            <input type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="例: 投稿画像A" />
          </label>
          <label className="field">
            <span>カテゴリ</span>
            <input type="text" list="cats" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <datalist id="cats">
              {d.project.categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>説明</span>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <AsyncButton
            className="btn primary block"
            onClick={async () => {
              try {
                const r = await post(`/api/app/projects/${d.project.id}/deliverables`, form);
                setForm(null);
                reload();
                nav(`/app/projects/${d.project.id}/deliverables/${r.id}`);
              } catch (e) {
                toast((e as ApiError).message);
              }
            }}
          >
            追加して版を提出へ
          </AsyncButton>
        </Modal>
      )}
    </div>
  );
}

function DeliveriesTab({ d, reload }: { d: Detail; reload: () => void }) {
  const pid = d.project.id;
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [cands, setCands] = useState<{ versionId: string; title: string; versionNumber: number; approved: boolean; fileName: string; size: number; statusLabel?: string; status: string }[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [form, setForm] = useState({ title: '最終納品', description: '', notice: '', expiresAt: '' });
  const [confirmPub, setConfirmPub] = useState<DeliveryDto | null>(null);
  async function openCreate() {
    const r = await get(`/api/app/projects/${pid}/delivery-candidates`);
    setCands(r.candidates);
    setSel(r.candidates.filter((c: { approved: boolean }) => c.approved).map((c: { versionId: string }) => c.versionId));
    setCreating(true);
  }
  return (
    <div className="stack">
      <div className="row between">
        <div className="muted small">承認済みの最新版だけを最終納品に含められます。作業ファイルとは分けて公開されます。</div>
        <AsyncButton className="btn primary" onClick={openCreate}>
          ＋ 納品セットを作成
        </AsyncButton>
      </div>
      {d.deliveries.length === 0 && <Empty>まだ納品セットはありません。</Empty>}
      {d.deliveries.map((x) => (
        <div key={x.id} className="card" data-testid="op-delivery">
          <div className="row between">
            <h3 style={{ margin: 0 }}>{x.title}</h3>
            <StatusBadge status={x.status} label={{ draft: '下書き', published: '公開中', withdrawn: '取り下げ' }[x.status]} />
          </div>
          {x.publishedAt && <div className="muted small">公開 {fmtDate(x.publishedAt)}</div>}
          {x.expiresAt && <div className="small">ダウンロード期限 {fmtDate(x.expiresAt)}{x.expired && <span className="badge danger">期限切れ</span>}</div>}
          <ul className="small" style={{ paddingLeft: 20 }}>
            {x.items.map((i) => (
              <li key={i.id}>
                {i.label} <span className="muted">（{i.file.name}, {fmtSize(i.file.size)}）</span>
                {!i.versionId && <span className="badge">追加ファイル</span>}
                {x.status === 'draft' && (
                  <button className="btn ghost small" onClick={async () => (await del(`/api/app/projects/${pid}/deliveries/${x.id}/items/${i.id}`).catch(() => undefined), reload())}>
                    外す
                  </button>
                )}
              </li>
            ))}
          </ul>
          {x.status === 'draft' && (
            <div style={{ marginBottom: 10 }}>
              <div className="small" style={{ fontWeight: 600 }}>追加の納品ファイル（元データ等・任意）</div>
              <Uploader initUrl={`/api/app/projects/${pid}/uploads`} extra={{ target: { purpose: 'delivery_extra', deliveryId: x.id } }} onUploaded={reload} mediaButton={false} />
            </div>
          )}
          <div className="row">
            {x.status === 'draft' && (
              <button className="btn primary" onClick={() => setConfirmPub(x)}>
                内容を確認して公開
              </button>
            )}
            {x.status === 'draft' && (
              <AsyncButton className="btn ghost small" onClick={async () => (await del(`/api/app/projects/${pid}/deliveries/${x.id}`), reload())}>
                下書きを削除
              </AsyncButton>
            )}
            {x.status === 'published' && (
              <>
                <a className="btn small" href={x.zipUrl}>
                  ZIPを確認
                </a>
                <AsyncButton
                  className="btn small"
                  onClick={async () => {
                    const v = prompt('ダウンロード期限（YYYY-MM-DD, 空欄で期限なし）', x.expiresAt?.slice(0, 10) ?? '');
                    if (v === null) return;
                    try {
                      await patch(`/api/app/projects/${pid}/deliveries/${x.id}`, { expiresAt: v ? new Date(`${v}T23:59:59+09:00`).toISOString() : null });
                      reload();
                    } catch (e) {
                      toast((e as ApiError).message);
                    }
                  }}
                >
                  期限を変更
                </AsyncButton>
                <AsyncButton
                  className="btn small ghost"
                  onClick={async () => {
                    if (!confirm('取り下げると顧客はダウンロードできなくなります。よろしいですか？')) return;
                    await post(`/api/app/projects/${pid}/deliveries/${x.id}/withdraw`);
                    reload();
                  }}
                >
                  取り下げ
                </AsyncButton>
              </>
            )}
          </div>
        </div>
      ))}
      {creating && (
        <Modal title="納品セットを作成" onClose={() => setCreating(false)}>
          <label className="field">
            <span>タイトル</span>
            <input type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </label>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>含める制作物（承認済みの最新版のみ選択可）</div>
          {cands.length === 0 && <div className="muted small">制作物がありません。</div>}
          {cands.map((c) => (
            <label key={c.versionId} className="check" style={!c.approved ? { opacity: 0.5 } : undefined}>
              <input type="checkbox" disabled={!c.approved} checked={sel.includes(c.versionId)} onChange={(e) => setSel(e.target.checked ? [...sel, c.versionId] : sel.filter((x) => x !== c.versionId))} />
              <span>
                {c.title} v{c.versionNumber} <span className="muted small">{c.fileName}</span> {!c.approved && <span className="badge warn">未承認</span>}
              </span>
            </label>
          ))}
          <label className="field">
            <span>説明</span>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <label className="field">
            <span>注意文（利用範囲など）</span>
            <textarea value={form.notice} onChange={(e) => setForm({ ...form, notice: e.target.value })} />
          </label>
          <label className="field">
            <span>ダウンロード期限（任意）</span>
            <input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
          </label>
          <AsyncButton
            className="btn primary block"
            disabled={sel.length === 0}
            onClick={async () => {
              try {
                await post(`/api/app/projects/${pid}/deliveries`, { ...form, expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T23:59:59+09:00`).toISOString() : null, versionIds: sel });
                setCreating(false);
                reload();
              } catch (e) {
                toast((e as ApiError).message);
              }
            }}
          >
            下書きとして作成
          </AsyncButton>
        </Modal>
      )}
      {confirmPub && (
        <Modal title="公開前の確認" onClose={() => setConfirmPub(null)}>
          <p className="small">以下のファイルを顧客「{d.client.companyName}」に公開します。</p>
          <ul className="small" style={{ paddingLeft: 20 }}>
            {confirmPub.items.map((i) => (
              <li key={i.id}>
                {i.label}（{i.file.name}）
              </li>
            ))}
          </ul>
          {confirmPub.expiresAt && <p className="small">ダウンロード期限: {fmtDate(confirmPub.expiresAt)}</p>}
          <AsyncButton
            className="btn primary block"
            onClick={async () => {
              try {
                await post(`/api/app/projects/${pid}/deliveries/${confirmPub.id}/publish`, { confirm: true });
                setConfirmPub(null);
                toast('納品を公開しました');
                reload();
              } catch (e) {
                toast((e as ApiError).message);
              }
            }}
          >
            公開する
          </AsyncButton>
        </Modal>
      )}
    </div>
  );
}

function ShareTab({ d, reload }: { d: Detail; reload: () => void }) {
  const me = useMe();
  const toast = useToast();
  const pid = d.project.id;
  const [days, setDays] = useState(14);
  const [sendEmail, setSendEmail] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [remind, setRemind] = useState('');
  return (
    <div className="stack">
      <div className="card">
        <h3>ポータル公開状態</h3>
        <div className="row">
          {(['draft', 'published', 'closed'] as const).map((s) => (
            <AsyncButton key={s} className={`btn small ${d.project.portalStatus === s ? 'primary' : ''}`} onClick={async () => (await post(`/api/app/projects/${pid}/portal`, { portalStatus: s }), reload())}>
              {{ draft: '非公開（準備中）', published: '公開', closed: '終了（アクセス不可）' }[s]}
            </AsyncButton>
          ))}
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>
          非公開・終了の間は、招待済みの顧客も案件ページを開けません。
        </div>
      </div>
      <div className="card">
        <h3>顧客を招待（{d.client.companyName}）</h3>
        <p className="small muted">
          招待リンクを発行し、メールやLINEで {d.client.contactName || d.client.companyName} 様（{d.client.email}）へ送ってください。開くときにこのメールアドレスの入力が必要です。再発行すると以前のリンクは使えなくなります。
        </p>
        <div className="row">
          <label className="row small">
            有効期限
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 110 }}>
              {[3, 7, 14, 30, 60, 90].map((n) => (
                <option key={n} value={n}>
                  {n}日
                </option>
              ))}
            </select>
          </label>
          {me.mailEnabled && (
            <label className="check small">
              <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
              メールでも送る
            </label>
          )}
          <AsyncButton
            className="btn primary"
            onClick={async () => {
              try {
                const r = await post(`/api/app/projects/${pid}/invites`, { days, sendEmail });
                setLink(r);
                reload();
                if (r.emailQueued) toast('招待メールを送信しました');
              } catch (e) {
                toast((e as ApiError).message);
              }
            }}
          >
            {d.access.some((a) => a.invites.some((i) => i.active)) ? '招待リンクを再発行' : '招待リンクを発行'}
          </AsyncButton>
        </div>
        {link && (
          <div className="alert ok" style={{ marginTop: 10 }}>
            <div className="small">招待リンク（この画面を閉じると再表示できません。必要なら再発行してください）</div>
            <div className="kbd" data-testid="invite-url">
              {link.url}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <button
                className="btn small"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link.url);
                    toast('コピーしました');
                  } catch {
                    toast('コピーできませんでした。長押しで選択してください');
                  }
                }}
              >
                コピー
              </button>
              {'share' in navigator && (
                <button className="btn small" onClick={() => navigator.share({ title: d.project.name, text: `${d.project.name} の専用ページです`, url: link.url }).catch(() => undefined)}>
                  共有
                </button>
              )}
              <span className="small muted">期限 {fmtDate(link.expiresAt)}</span>
            </div>
          </div>
        )}
      </div>
      {d.access.map((a) => (
        <div key={a.id} className="card flat">
          <div className="row between">
            <h3 style={{ margin: 0 }}>
              {a.client.companyName} のアクセス <StatusBadge status={a.status === 'active' ? 'approved' : 'changes_requested'} label={a.status === 'active' ? '有効' : '停止中'} />
            </h3>
            <AsyncButton className={`btn small ${a.status === 'active' ? 'danger' : ''}`} onClick={async () => (await post(`/api/app/projects/${pid}/access/${a.id}`, { action: a.status === 'active' ? 'revoke' : 'restore' }), reload())}>
              {a.status === 'active' ? 'アクセスを停止' : 'アクセスを再開'}
            </AsyncButton>
          </div>
          <table className="tbl small" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>発行</th>
                <th>期限</th>
                <th>利用</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {a.invites.map((i) => (
                <tr key={i.id}>
                  <td>{fmtDate(i.createdAt)}</td>
                  <td>{fmtDate(i.expiresAt)}</td>
                  <td>
                    {i.useCount}回{i.lastUsedAt && <div className="muted">最終 {fmtDate(i.lastUsedAt)}</div>}
                  </td>
                  <td>{i.active ? '有効' : i.revokedAt ? '失効' : '期限切れ'}</td>
                  <td>
                    {i.active && (
                      <AsyncButton className="btn ghost small" onClick={async () => (await post(`/api/app/projects/${pid}/invites/${i.id}/revoke`), reload())}>
                        失効
                      </AsyncButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {d.access.length > 0 && (
        <div className="card flat">
          <h3>顧客へリマインド</h3>
          <textarea value={remind} onChange={(e) => setRemind(e.target.value)} placeholder="例: 資料のご提出をお願いいたします" />
          <AsyncButton
            className="btn small"
            onClick={async () => {
              try {
                await post(`/api/app/projects/${pid}/remind`, { message: remind });
                setRemind('');
                toast('お知らせを送りました');
              } catch (e) {
                toast((e as ApiError).message);
              }
            }}
          >
            お知らせを送る
          </AsyncButton>
        </div>
      )}
    </div>
  );
}

function FilesTab({ d, reload }: { d: Detail; reload: () => void }) {
  const toast = useToast();
  return (
    <div className="stack">
      <div className="alert warn small">🔒 作業ファイルは顧客に公開されません（ポータル・納品ZIPに含まれません）。</div>
      <Uploader initUrl={`/api/app/projects/${d.project.id}/uploads`} extra={{ target: { purpose: 'internal' } }} onUploaded={reload} />
      {d.internalFiles.length === 0 ? (
        <Empty>作業ファイルはありません。</Empty>
      ) : (
        <div className="list">
          {d.internalFiles.map((f) => (
            <div key={f.id} className="item">
              <div className="grow">
                <a href={f.url} target="_blank" rel="noreferrer">
                  {f.name}
                </a>
                <div className="muted small">
                  {fmtSize(f.size)} ・ {fmtDate(f.createdAt)}
                </div>
              </div>
              <a className="btn small" href={f.downloadUrl}>
                ⬇
              </a>
              <AsyncButton
                className="btn small ghost"
                onClick={async () => {
                  if (!confirm('取り下げますか？')) return;
                  await post(`/api/app/projects/${d.project.id}/files/${f.id}/withdraw`).catch((e) => toast((e as ApiError).message));
                  reload();
                }}
              >
                取り下げ
              </AsyncButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityTab({ d }: { d: Detail }) {
  const st = useApi<{ events: { seq: number; actorType: string; actorName: string; action: string; summary: string; clientVisible: boolean; at: string }[] }>(`/api/app/projects/${d.project.id}/activity`);
  return (
    <Page state={st}>
      {(x) => (
        <ul className="timeline">
          {x.events.map((e) => (
            <li key={e.seq}>
              <div>
                {e.summary || e.action} {e.clientVisible && <span className="badge">顧客にも表示</span>}
              </div>
              <div className="muted small">
                {fmtDate(e.at)} ／ {e.actorType === 'client' ? `顧客: ${e.actorName}` : e.actorType === 'system' ? '自動' : e.actorType === 'anonymous' ? '未認証アクセス' : e.actorName} ／ {e.action}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

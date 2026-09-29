import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, del, patch, post } from '../../api';
import { AsyncButton, Empty, Modal, Page, fmtDate, useApi, useTitle, useToast } from '../../components/ui';

interface Client {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  internalMemo: string;
  status: string;
  isSample: boolean;
  projectCount?: number;
}

function ClientForm({ initial, onSave }: { initial?: Client; onSave: (f: Omit<Client, 'id' | 'status' | 'isSample'>) => Promise<void> }) {
  const [f, setF] = useState({ companyName: initial?.companyName ?? '', contactName: initial?.contactName ?? '', email: initial?.email ?? '', phone: initial?.phone ?? '', internalMemo: initial?.internalMemo ?? '' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <label className="field">
        <span>会社名・屋号</span>
        <input type="text" value={f.companyName} onChange={set('companyName')} />
      </label>
      <label className="field">
        <span>担当者名</span>
        <input type="text" value={f.contactName} onChange={set('contactName')} />
      </label>
      <label className="field">
        <span>メールアドレス（招待時の本人確認に使用）</span>
        <input type="email" value={f.email} onChange={set('email')} />
      </label>
      <label className="field">
        <span>電話（任意）</span>
        <input type="text" inputMode="tel" value={f.phone} onChange={set('phone')} />
      </label>
      <label className="field">
        <span>🔒 内部メモ（顧客には表示されません）</span>
        <textarea value={f.internalMemo} onChange={set('internalMemo')} />
      </label>
      {error && <div className="alert error">{error}</div>}
      <AsyncButton
        className="btn primary block"
        onClick={async () => {
          setError(null);
          try {
            await onSave(f);
          } catch (e) {
            setError((e as ApiError).message);
          }
        }}
      >
        保存
      </AsyncButton>
    </div>
  );
}

export function ClientList() {
  useTitle('顧客');
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');
  const st = useApi<{ clients: Client[] }>(`/api/app/clients?status=${status}&q=${encodeURIComponent(q)}`, [status, q]);
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>顧客</h1>
        <button className="btn primary" onClick={() => setAdding(true)}>
          ＋ 顧客を追加
        </button>
      </div>
      <div className="row">
        <input type="search" placeholder="会社名・担当者・メール" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 180 }} aria-label="表示">
          <option value="active">有効</option>
          <option value="archived">アーカイブ</option>
          <option value="all">すべて</option>
        </select>
      </div>
      <Page state={st}>
        {(d) =>
          d.clients.length === 0 ? (
            <Empty>顧客がいません。</Empty>
          ) : (
            <div className="list">
              {d.clients.map((c) => (
                <Link key={c.id} to={`/app/clients/${c.id}`} className="item">
                  <div className="grow">
                    <div className="title">
                      {c.companyName} {c.isSample && <span className="badge info">サンプル</span>} {c.status === 'archived' && <span className="badge">アーカイブ</span>}
                    </div>
                    <div className="muted small">
                      {c.contactName} ／ {c.email}
                    </div>
                  </div>
                  <span className="badge">案件 {c.projectCount}</span>
                </Link>
              ))}
            </div>
          )
        }
      </Page>
      {adding && (
        <Modal title="顧客を追加" onClose={() => setAdding(false)}>
          <ClientForm
            onSave={async (f) => {
              const r = await post('/api/app/clients', f);
              nav(`/app/clients/${r.id}`);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

export function ClientDetail() {
  const { cid } = useParams();
  const st = useApi<{ client: Client; activeSessions: number; projects: { id: string; name: string; statusLabel: string; dueDate: string | null; archived: boolean; portalStatus: string }[] }>(`/api/app/clients/${cid}`, [cid]);
  const [edit, setEdit] = useState(false);
  const toast = useToast();
  const nav = useNavigate();
  useTitle(st.data?.client.companyName ?? '顧客');
  return (
    <Page state={st}>
      {(d) => (
        <div className="stack">
          <div className="muted small">
            <Link to="/app/clients">顧客</Link>
          </div>
          <div className="row between">
            <h1 style={{ margin: 0 }}>{d.client.companyName}</h1>
            {d.client.status === 'archived' && <span className="badge">アーカイブ</span>}
          </div>
          <div className="card">
            {edit ? (
              <ClientForm
                initial={d.client}
                onSave={async (f) => {
                  await patch(`/api/app/clients/${d.client.id}`, f);
                  setEdit(false);
                  st.reload();
                }}
              />
            ) : (
              <div className="small">
                <p>担当者: {d.client.contactName}</p>
                <p>メール: {d.client.email}</p>
                {d.client.phone && <p>電話: {d.client.phone}</p>}
                <div className="alert warn pre">🔒 内部メモ: {d.client.internalMemo || 'なし'}</div>
                <p className="muted">この顧客の有効な端末セッション: {d.activeSessions}</p>
                <button className="btn small" onClick={() => setEdit(true)}>
                  編集
                </button>
              </div>
            )}
          </div>
          <h2>案件</h2>
          {d.projects.length === 0 ? (
            <Empty>案件はありません。</Empty>
          ) : (
            <div className="list">
              {d.projects.map((p) => (
                <Link key={p.id} to={`/app/projects/${p.id}`} className="item">
                  <div className="grow">
                    <div className="title">{p.name}</div>
                    <div className="muted small">{p.dueDate && `納期 ${fmtDate(p.dueDate)}`}</div>
                  </div>
                  <span className="badge info">{p.statusLabel}</span>
                  {p.archived && <span className="badge">アーカイブ</span>}
                </Link>
              ))}
            </div>
          )}
          <div className="card flat">
            <h3>アクセス・アーカイブ</h3>
            <div className="row">
              <AsyncButton
                className="btn small danger"
                onClick={async () => {
                  if (!confirm('この顧客のすべての案件へのアクセスを停止し、招待リンクを失効、ログイン中の端末をログアウトします。よろしいですか？')) return;
                  await post(`/api/app/clients/${d.client.id}/suspend-access`);
                  toast('アクセスを停止しました');
                  st.reload();
                }}
              >
                全案件のアクセスを停止
              </AsyncButton>
              <AsyncButton
                className="btn small"
                onClick={async () => {
                  await post(`/api/app/clients/${d.client.id}/archive`, { archived: d.client.status !== 'archived' });
                  st.reload();
                }}
              >
                {d.client.status === 'archived' ? 'アーカイブ解除' : 'アーカイブ'}
              </AsyncButton>
              <AsyncButton
                className="btn small ghost"
                onClick={async () => {
                  if (!confirm('顧客を削除しますか？（案件がある場合は削除できません）')) return;
                  try {
                    await del(`/api/app/clients/${d.client.id}`);
                    nav('/app/clients');
                  } catch (e) {
                    toast((e as ApiError).message);
                  }
                }}
              >
                削除
              </AsyncButton>
            </div>
            <p className="muted small" style={{ marginTop: 6 }}>
              過去の案件がある顧客は削除せずアーカイブしてください（案件履歴を保持します）。
            </p>
          </div>
        </div>
      )}
    </Page>
  );
}

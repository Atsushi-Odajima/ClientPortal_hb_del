import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, get, post } from '../../api';
import { AsyncButton, Empty, Modal, Page, fmtDate, isOverdue, useApi, useTitle } from '../../components/ui';
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL } from '../../../../shared/labels';

interface ProjectRow {
  id: string;
  name: string;
  clientName: string;
  status: string;
  statusLabel: string;
  dueDate: string | null;
  portalStatus: string;
  pendingRequests: number;
  submittedRequests: number;
  totalRequests: number;
  isSample: boolean;
  updatedAt: string;
}

export function ProjectList() {
  useTitle('案件');
  const [sp, setSp] = useSearchParams();
  const [showNew, setShowNew] = useState(sp.get('new') === '1');
  const qs = new URLSearchParams();
  for (const k of ['q', 'status', 'clientId', 'dueBefore', 'approval', 'pendingRequests', 'archived']) if (sp.get(k)) qs.set(k, sp.get(k)!);
  const st = useApi<{ total: number; projects: ProjectRow[] }>(`/api/app/projects?${qs}`, [qs.toString()]);
  const clients = useApi<{ clients: { id: string; companyName: string }[] }>('/api/app/clients');
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    n.delete('new');
    setSp(n, { replace: true });
  };
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>案件</h1>
        <button className="btn primary" onClick={() => setShowNew(true)}>
          ＋ 新しい案件
        </button>
      </div>
      <details className="card flat" open={!!(sp.get('status') || sp.get('clientId') || sp.get('approval') || sp.get('pendingRequests') || sp.get('dueBefore'))}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>絞り込み</summary>
        <div className="grid cols-3" style={{ marginTop: 10 }}>
          <label className="field">
            <span>キーワード</span>
            <input type="search" defaultValue={sp.get('q') ?? ''} onBlur={(e) => set('q', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value)} placeholder="案件名・顧客名" />
          </label>
          <label className="field">
            <span>状態</span>
            <select value={sp.get('status') ?? ''} onChange={(e) => set('status', e.target.value)}>
              <option value="">すべて</option>
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>顧客</span>
            <select value={sp.get('clientId') ?? ''} onChange={(e) => set('clientId', e.target.value)}>
              <option value="">すべて</option>
              {clients.data?.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.companyName}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>承認状態</span>
            <select value={sp.get('approval') ?? ''} onChange={(e) => set('approval', e.target.value)}>
              <option value="">すべて</option>
              <option value="pending">顧客確認待ちあり</option>
              <option value="changes">修正依頼あり</option>
              <option value="all_approved">すべて承認済み</option>
            </select>
          </label>
          <label className="field">
            <span>納期（この日まで）</span>
            <input type="date" value={sp.get('dueBefore') ?? ''} onChange={(e) => set('dueBefore', e.target.value)} />
          </label>
          <div>
            <label className="check">
              <input type="checkbox" checked={sp.get('pendingRequests') === '1'} onChange={(e) => set('pendingRequests', e.target.checked ? '1' : '')} />
              未提出資料がある案件
            </label>
            <label className="check">
              <input type="checkbox" checked={sp.get('archived') === '1'} onChange={(e) => set('archived', e.target.checked ? '1' : '')} />
              アーカイブ済みを表示
            </label>
          </div>
        </div>
      </details>
      <Page state={st}>
        {(d) =>
          d.projects.length === 0 ? (
            <Empty>案件がありません。「＋ 新しい案件」から作成してください。</Empty>
          ) : (
            <div className="list">
              <div className="muted small">{d.total} 件</div>
              {d.projects.map((p) => (
                <Link key={p.id} to={`/app/projects/${p.id}`} className="item">
                  <div className="grow">
                    <div className="title">
                      {p.name} {p.isSample && <span className="badge info">サンプル</span>}
                    </div>
                    <div className="muted small">
                      {p.clientName}
                      {p.dueDate && (
                        <span style={isOverdue(p.dueDate) && !['delivered', 'completed', 'cancelled'].includes(p.status) ? { color: 'var(--danger)' } : undefined}>
                          {' '}
                          ／ 納期 {fmtDate(p.dueDate)}
                        </span>
                      )}
                      {p.totalRequests > 0 && (
                        <>
                          {' '}
                          ／ 資料 {p.totalRequests - p.pendingRequests}/{p.totalRequests}
                        </>
                      )}
                    </div>
                  </div>
                  <span className="badge info">{p.statusLabel}</span>
                  {p.submittedRequests > 0 && <span className="badge warn">要確認 {p.submittedRequests}</span>}
                  {p.portalStatus !== 'published' && <span className="badge">非公開</span>}
                </Link>
              ))}
            </div>
          )
        }
      </Page>
      {showNew && <NewProjectModal onClose={() => (setShowNew(false), set('new', ''))} />}
    </div>
  );
}

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [clients, setClients] = useState<{ id: string; companyName: string }[] | null>(null);
  const [templates, setTemplates] = useState<{ id: string; name: string; description: string }[]>([]);
  const [f, setF] = useState({ clientId: '', name: '', description: '', dueDate: '', startDate: '', templateId: '', clientGuidance: '' });
  const [newClient, setNewClient] = useState({ companyName: '', contactName: '', email: '' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get('/api/app/clients').then((r) => {
      setClients(r.clients);
      if (r.clients.length) setF((x) => ({ ...x, clientId: r.clients[0].id }));
      else setF((x) => ({ ...x, clientId: '__new' }));
    });
    get('/api/app/templates').then((r) => setTemplates(r.templates), () => undefined);
  }, []);
  async function create() {
    setError(null);
    try {
      let clientId = f.clientId;
      if (clientId === '__new') {
        clientId = (await post('/api/app/clients', newClient)).id;
      }
      const r = await post('/api/app/projects', {
        clientId,
        name: f.name,
        description: f.description,
        dueDate: f.dueDate || null,
        startDate: f.startDate || null,
        templateId: f.templateId || undefined,
        clientGuidance: f.clientGuidance,
      });
      nav(`/app/projects/${r.id}`);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }
  return (
    <Modal title="新しい案件" onClose={onClose}>
      {!clients ? null : (
        <>
          <label className="field">
            <span>顧客</span>
            <select value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.companyName}
                </option>
              ))}
              <option value="__new">＋ 新しい顧客を登録</option>
            </select>
          </label>
          {f.clientId === '__new' && (
            <div className="card flat" style={{ marginBottom: 12 }}>
              <label className="field">
                <span>会社名・屋号</span>
                <input type="text" value={newClient.companyName} onChange={(e) => setNewClient({ ...newClient, companyName: e.target.value })} />
              </label>
              <label className="field">
                <span>担当者名</span>
                <input type="text" value={newClient.contactName} onChange={(e) => setNewClient({ ...newClient, contactName: e.target.value })} />
              </label>
              <label className="field">
                <span>メールアドレス（招待時の本人確認に使います）</span>
                <input type="email" value={newClient.email} onChange={(e) => setNewClient({ ...newClient, email: e.target.value })} />
              </label>
            </div>
          )}
          <label className="field">
            <span>案件名</span>
            <input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label className="field">
            <span>テンプレート（資料リクエスト等を複製）</span>
            <select value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}>
              <option value="">使わない</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
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
          {error && <div className="alert error">{error}</div>}
          <AsyncButton className="btn primary block" onClick={create}>
            作成する
          </AsyncButton>
        </>
      )}
    </Modal>
  );
}

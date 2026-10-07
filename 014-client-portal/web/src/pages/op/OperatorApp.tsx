import { createContext, useContext, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { ApiError, get, post } from '../../api';
import { ErrorBox, Loading } from '../../components/ui';
import { Dashboard } from './Dashboard';
import { ProjectList } from './Projects';
import { ProjectDetail } from './ProjectDetail';
import { DeliverableOp, OperatorSheet } from './DeliverableOp';
import { SelectionOp } from './SelectionOp';
import { ClientDetail, ClientList } from './Clients';
import { AuditPage, NotificationsPage, SearchPage, SettingsPage, TemplatesPage } from './Misc';

export interface OpMe {
  operator: { id: string; email: string; name: string; business_name: string };
  mailEnabled: boolean;
  limits: { maxUploadBytes: number };
}

const MeCtx = createContext<OpMe | null>(null);
export const useMe = () => useContext(MeCtx)!;

export default function OperatorApp() {
  const [me, setMe] = useState<OpMe | null>(null);
  const [unread, setUnread] = useState(0);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const [loadErr, setLoadErr] = useState<ApiError | null>(null);
  useEffect(() => {
    const load = () =>
      get<OpMe>('/api/auth/me').then(
        (m) => (setMe(m), setLoadErr(null)),
        (e: ApiError) => {
          if (e.status === 401) nav('/login', { replace: true });
          else setLoadErr(e);
        },
      );
    load();
    window.addEventListener('online', load);
    return () => window.removeEventListener('online', load);
  }, [nav]);
  useEffect(() => {
    if (!me) return;
    const load = () => get('/api/app/notifications').then((r) => setUnread(r.unread), () => undefined);
    load();
    const t = window.setInterval(load, 60_000);
    window.addEventListener('cp:notifications', load);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('cp:notifications', load);
    };
  }, [me]);
  if (!me && loadErr) return <div className="center-page"><ErrorBox error={loadErr} onRetry={() => location.reload()} /></div>;
  if (!me) return <Loading />;
  const navItems = [
    { to: '/app', ico: '🏠', label: 'ホーム', end: true },
    { to: '/app/projects', ico: '📁', label: '案件' },
    { to: '/app/clients', ico: '👥', label: '顧客' },
    { to: '/app/notifications', ico: '🔔', label: '通知', badge: unread },
    { to: '/app/settings', ico: '⚙️', label: '設定' },
  ];
  return (
    <MeCtx.Provider value={me}>
      <div className="app with-sidebar">
        <aside className="sidebar" aria-label="メインメニュー">
          <Link className="brand" to="/app">
            Client Portal
          </Link>
          {[...navItems.slice(0, 3), { to: '/app/templates', ico: '🧩', label: 'テンプレート' }, navItems[3], { to: '/app/audit', ico: '🧾', label: '監査ログ' }, navItems[4]].map((n) => (
            <NavLink key={n.to} to={n.to} end={'end' in n ? n.end : false} className="nav">
              <span>{n.ico}</span>
              {n.label}
              {'badge' in n && !!n.badge && <span className="navbadge">{n.badge}</span>}
            </NavLink>
          ))}
          <div style={{ flex: 1 }} />
          <div className="muted small" style={{ padding: '0 10px' }}>
            {me.operator.business_name || me.operator.name}
          </div>
          <button
            className="btn ghost small"
            onClick={async () => {
              await post('/api/auth/logout').catch(() => undefined);
              nav('/login');
            }}
          >
            ログアウト
          </button>
        </aside>
        <div className="content">
          <header className="topbar">
            <Link className="brand" to="/app">
              Client Portal
            </Link>
            <form
              className="spacer"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                if (q.trim()) nav(`/app/search?q=${encodeURIComponent(q.trim())}`);
              }}
            >
              <input type="search" placeholder="案件・顧客・ファイル・制作物を検索" value={q} onChange={(e) => setQ(e.target.value)} aria-label="検索" style={{ minHeight: 40, padding: '6px 12px' }} />
            </form>
          </header>
          <main className="main">
            <Routes>
              <Route index element={<Dashboard />} />
              <Route path="projects" element={<ProjectList />} />
              <Route path="projects/:pid" element={<ProjectDetail />} />
              <Route path="projects/:pid/deliverables/:did" element={<DeliverableOp />} />
              <Route path="projects/:pid/deliverables/:did/sheet/:vid" element={<OperatorSheet />} />
              <Route path="projects/:pid/selections/:sid" element={<SelectionOp />} />
              <Route path="clients" element={<ClientList />} />
              <Route path="clients/:cid" element={<ClientDetail />} />
              <Route path="templates" element={<TemplatesPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="*" element={<Navigate to="/app" replace />} />
            </Routes>
          </main>
        </div>
        <nav className="bottomnav" aria-label="メインメニュー">
          {navItems.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              <span className="ico">{n.ico}</span>
              {n.label}
              {!!n.badge && <span className="navbadge">{n.badge}</span>}
            </NavLink>
          ))}
        </nav>
      </div>
    </MeCtx.Provider>
  );
}

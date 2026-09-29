import { StrictMode, lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { ToastProvider, Loading, OfflineBanner } from './components/ui';
import { get } from './api';
import { LoginPage, SetupPage, SignupPage } from './pages/auth/Auth';
import { InvitePage, PortalLoginPage } from './pages/portal/Invite';

const OperatorApp = lazy(() => import('./pages/op/OperatorApp'));
const PortalApp = lazy(() => import('./pages/portal/PortalApp'));

function Root() {
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        await get('/api/auth/me');
        return setTarget('/app');
      } catch {
        /* not operator */
      }
      try {
        await get('/api/portal/me');
        return setTarget('/portal');
      } catch {
        /* not client */
      }
      try {
        const st = await get('/api/auth/state');
        setTarget(st.hasOperators ? '/login' : '/setup');
      } catch {
        setTarget('/login');
      }
    })();
  }, []);
  if (!target) return <Loading />;
  return <Navigate to={target} replace />;
}

function App() {
  return (
    <ToastProvider>
      <OfflineBanner />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Root />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path="/portal/login" element={<PortalLoginPage />} />
          <Route path="/app/*" element={<OperatorApp />} />
          <Route path="/portal/*" element={<PortalApp />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ToastProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// Service Worker は HTTPS（または localhost）でのみ有効
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

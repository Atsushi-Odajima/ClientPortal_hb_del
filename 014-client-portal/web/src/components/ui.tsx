import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, get } from '../api';

export function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="offline" role="status">
      オフラインです。表示中の内容は古い可能性があります。提出・承認などの送信はできません。
    </div>
  );
}

/** GET取得フック。再接続時に自動で再取得（最新版の再確認） */
export function useApi<T = any>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try {
      setData(await get<T>(url));
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const on = () => void reload();
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export function Loading({ label = '読み込み中…' }: { label?: string }) {
  return (
    <div className="muted" role="status" style={{ padding: 24, textAlign: 'center' }}>
      {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      {error.message}
      {onRetry && (
        <div style={{ marginTop: 8 }}>
          <button className="btn small" onClick={onRetry}>
            再読み込み
          </button>
        </div>
      )}
    </div>
  );
}

export function Page<T>({ state, children }: { state: { data: T | null; error: ApiError | null; loading: boolean; reload: () => void }; children: (d: T) => ReactNode }) {
  if (state.error && !state.data) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading />;
  return <>{children(state.data)}</>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn ghost small" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const ToastCtx = createContext<(msg: string) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>(0);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status" aria-live="polite">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** 送信中の多重押下を防ぐボタン */
export function AsyncButton({
  onClick,
  children,
  className = 'btn',
  disabled,
  requireOnline = true,
  type = 'button',
}: {
  onClick: () => Promise<unknown> | unknown;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  requireOnline?: boolean;
  type?: 'button' | 'submit';
}) {
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  return (
    <button
      type={type}
      className={className}
      disabled={busy || disabled || (requireOnline && !online)}
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? '処理中…' : children}
    </button>
  );
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${y}/${Number(m)}/${Number(d)}`;
  }
  const d = new Date(s);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function isOverdue(ymd: string | null | undefined): boolean {
  if (!ymd) return false;
  return ymd < new Date().toISOString().slice(0, 10);
}

const STATUS_TONE: Record<string, string> = {
  pending: 'warn',
  returned: 'danger',
  submitted: 'info',
  accepted: 'ok',
  in_review: 'info',
  changes_requested: 'danger',
  approved: 'ok',
  superseded: '',
  draft: '',
  published: 'ok',
  withdrawn: '',
};

export function StatusBadge({ status, label }: { status: string; label: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? ''}`}>{label}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="card flat muted" style={{ textAlign: 'center', padding: 24 }}>
      {children}
    </div>
  );
}

export function useTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} | Client Portal` : 'Client Portal';
  }, [title]);
}

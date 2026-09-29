import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, get, post } from '../../api';
import { Loading, fmtDate, useTitle } from '../../components/ui';

interface InviteInfo {
  valid: boolean;
  message?: string;
  kind?: 'invite' | 'magic';
  projectName?: string;
  providerName?: string;
  clientCompany?: string;
  emailHint?: string;
  expiresAt?: string;
}

/** 招待リンク /invite#t=<token>（フラグメントはサーバーへ送信されず、ログ・Refererに残らない） */
export function InvitePage() {
  useTitle('ご案内');
  const nav = useNavigate();
  const token = useRef<{ t: string; kind: 't' | 'm' } | null>(null);
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token.current) {
      const h = new URLSearchParams(window.location.hash.slice(1));
      const t = h.get('t');
      const m = h.get('m');
      token.current = t ? { t, kind: 't' } : m ? { t: m, kind: 'm' } : null;
      // アドレスバー・履歴からトークンを消す
      window.history.replaceState(null, '', '/invite');
    }
    const tk = token.current;
    if (!tk) {
      setInfo({ valid: false, message: 'リンクが正しくありません。担当者から届いたリンクをもう一度開いてください' });
      return;
    }
    (async () => {
      try {
        const r = await post<InviteInfo>('/api/invite/inspect', { token: tk.t });
        if (r.valid && tk.kind === 'm') {
          const red = await post('/api/invite/redeem', { token: tk.t });
          nav(`/portal/p/${red.projectId}`, { replace: true });
          return;
        }
        setInfo(r);
      } catch (e) {
        setInfo({ valid: false, message: (e as ApiError).message });
      }
    })();
  }, [nav]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token.current) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post('/api/invite/redeem', { token: token.current.t, email });
      nav(`/portal/p/${r.projectId}`, { replace: true });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (!info) return <Loading label="確認しています…" />;
  if (!info.valid)
    return (
      <div className="center-page">
        <div className="card">
          <h1>リンクを開けませんでした</h1>
          <p>{info.message}</p>
          <p className="muted small">すでにこの端末でご利用中の場合は、下のボタンから開けます。</p>
          <a className="btn block" href="/portal">
            お客様ページを開く
          </a>
        </div>
      </div>
    );
  return (
    <div className="center-page">
      <div className="card">
        <p className="muted small">{info.providerName} からのご案内</p>
        <h1>{info.projectName}</h1>
        <p>
          {info.clientCompany} 様専用のページです。資料のご提出、制作物のご確認・承認、納品物の受け取りができます。
        </p>
        <form onSubmit={submit}>
          <label className="field">
            <span>ご本人確認のため、招待を受けたメールアドレスを入力してください（{info.emailHint}）</span>
            <input type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          {error && <div className="alert error">{error}</div>}
          <button className="btn primary block" disabled={busy}>
            {busy ? '確認中…' : 'ページを開く'}
          </button>
        </form>
        <p className="muted small" style={{ marginTop: 12 }}>
          このリンクの有効期限: {fmtDate(info.expiresAt)}。一度開くと、この端末ではしばらくリンクなしで利用できます。リンクは他の方に転送しないでください。
        </p>
      </div>
    </div>
  );
}

export function PortalLoginPage() {
  useTitle('お客様ページ');
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [mail, setMail] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get('/api/auth/state').then((s) => setMail(s.mailEnabled), () => setMail(false));
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post('/api/portal/magic-link', { email });
      setMsg(r.message);
    } catch (err) {
      setMsg((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="center-page">
      <div className="card">
        <h1>お客様ページを開けない場合</h1>
        <p>担当者から届いた招待リンクを開いてください。リンクの期限が切れている場合は、担当者に「招待リンクの再発行」をご依頼ください。</p>
        {mail && (
          <form onSubmit={submit} style={{ marginTop: 16 }}>
            <label className="field">
              <span>ログイン用リンクをメールで受け取る</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="招待を受けたメールアドレス" />
            </label>
            <button className="btn primary block" disabled={busy}>
              リンクを送信
            </button>
          </form>
        )}
        {msg && <div className="alert" style={{ marginTop: 12 }}>{msg}</div>}
      </div>
    </div>
  );
}

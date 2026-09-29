import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, get, post } from '../../api';
import { useTitle } from '../../components/ui';

export function LoginPage() {
  useTitle('ログイン');
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ allowSignup: boolean; hasOperators: boolean } | null>(null);
  useEffect(() => {
    get('/api/auth/state').then(setState, () => undefined);
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/login', { email, password });
      nav('/app', { replace: true });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="center-page">
      <h1 style={{ color: 'var(--primary)' }}>Client Portal</h1>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>運営者ログイン</h2>
        <form onSubmit={submit}>
          <label className="field">
            <span>メールアドレス</span>
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field">
            <span>パスワード</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <div className="alert error">{error}</div>}
          <button className="btn primary block" disabled={busy}>
            {busy ? 'ログイン中…' : 'ログイン'}
          </button>
        </form>
        {state?.allowSignup && (
          <p className="small" style={{ marginTop: 12 }}>
            アカウントをお持ちでない方は <Link to="/signup">新規登録</Link>
          </p>
        )}
        {state && !state.hasOperators && (
          <p className="small" style={{ marginTop: 12 }}>
            初めて使う場合は <Link to="/setup">初期設定</Link>
          </p>
        )}
      </div>
      <p className="muted small" style={{ marginTop: 16 }}>
        お客様（顧客）の方は、担当者から届いた招待リンクから開いてください。<br />
        <Link to="/portal/login">お客様用ページを開けない場合</Link>
      </p>
    </div>
  );
}

function OperatorForm({ mode }: { mode: 'setup' | 'signup' }) {
  const nav = useNavigate();
  const [f, setF] = useState({ email: '', name: '', businessName: '', password: '', setupToken: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  useEffect(() => {
    get('/api/auth/state').then((s) => setNeedsToken(s.setupRequiresToken), () => undefined);
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(mode === 'setup' ? '/api/auth/setup' : '/api/auth/signup', f);
      nav('/app', { replace: true });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form onSubmit={submit}>
      {mode === 'setup' && needsToken && (
        <label className="field">
          <span>セットアップ用トークン（サーバーの SETUP_TOKEN）</span>
          <input type="password" value={f.setupToken} onChange={set('setupToken')} required />
        </label>
      )}
      <label className="field">
        <span>氏名</span>
        <input type="text" value={f.name} onChange={set('name')} required autoComplete="name" />
      </label>
      <label className="field">
        <span>屋号・会社名（お客様の画面に表示されます）</span>
        <input type="text" value={f.businessName} onChange={set('businessName')} autoComplete="organization" />
      </label>
      <label className="field">
        <span>メールアドレス（ログインID）</span>
        <input type="email" value={f.email} onChange={set('email')} required autoComplete="username" />
      </label>
      <label className="field">
        <span>パスワード（10文字以上）</span>
        <input type="password" value={f.password} onChange={set('password')} required minLength={10} autoComplete="new-password" />
      </label>
      {error && <div className="alert error">{error}</div>}
      <button className="btn primary block" disabled={busy}>
        {busy ? '作成中…' : 'アカウントを作成'}
      </button>
    </form>
  );
}

export function SetupPage() {
  useTitle('初期設定');
  return (
    <div className="center-page">
      <h1 style={{ color: 'var(--primary)' }}>Client Portal 初期設定</h1>
      <div className="card">
        <p className="small">最初の運営者アカウントを作成します。</p>
        <OperatorForm mode="setup" />
      </div>
    </div>
  );
}

export function SignupPage() {
  useTitle('新規登録');
  return (
    <div className="center-page">
      <h1 style={{ color: 'var(--primary)' }}>運営者アカウント作成</h1>
      <div className="card">
        <OperatorForm mode="signup" />
      </div>
      <p className="small" style={{ marginTop: 12 }}>
        <Link to="/login">ログインへ戻る</Link>
      </p>
    </div>
  );
}

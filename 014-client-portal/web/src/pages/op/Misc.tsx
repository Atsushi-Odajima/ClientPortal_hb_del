import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api, del, patch, post } from '../../api';
import { AsyncButton, Empty, ErrorBox, Loading, Modal, Page, fmtDate, fmtSize, useApi, useTitle, useToast } from '../../components/ui';
import { REQUEST_KIND_LABEL } from '../../../../shared/labels';
import { useMe } from './OperatorApp';

interface TemplateReq {
  title: string;
  description?: string;
  kind: keyof typeof REQUEST_KIND_LABEL;
  required?: boolean;
  choices?: string[];
}
interface Template {
  id: string;
  name: string;
  description: string;
  clientGuidance: string;
  requests: TemplateReq[];
  categories: string[];
  checklist: string[];
}

export function TemplatesPage() {
  useTitle('テンプレート');
  const st = useApi<{ templates: Template[] }>('/api/app/templates');
  const [edit, setEdit] = useState<Template | null>(null);
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>案件テンプレート</h1>
        <button className="btn primary" onClick={() => setEdit({ id: '', name: '', description: '', clientGuidance: '', requests: [], categories: [], checklist: [] })}>
          ＋ テンプレート
        </button>
      </div>
      <p className="muted small">新しい案件を作るときに、資料リクエスト・顧客向け案内・制作物カテゴリ・標準確認項目を複製します。テンプレートを後で編集しても、作成済みの案件は変わりません。</p>
      <Page state={st}>
        {(d) => (
          <div className="grid cols-2">
            {d.templates.map((t) => (
              <div key={t.id} className="card">
                <div className="row between">
                  <h3 style={{ margin: 0 }}>{t.name}</h3>
                  <button className="btn small" onClick={() => setEdit(t)}>
                    編集
                  </button>
                </div>
                {t.description && <p className="small muted">{t.description}</p>}
                <div className="small">資料: {t.requests.map((r) => r.title).join('、') || 'なし'}</div>
                <div className="small muted">カテゴリ: {t.categories.join('、') || 'なし'}</div>
              </div>
            ))}
          </div>
        )}
      </Page>
      {edit && <TemplateEditor t={edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), st.reload())} />}
    </div>
  );
}

function TemplateEditor({ t, onClose, onSaved }: { t: Template; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ ...t, categoriesText: t.categories.join('\n'), checklistText: t.checklist.join('\n') });
  const [reqs, setReqs] = useState<TemplateReq[]>(t.requests);
  const [error, setError] = useState<string | null>(null);
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <Modal title={t.id ? 'テンプレートを編集' : 'テンプレートを作成'} onClose={onClose}>
      <label className="field">
        <span>名前</span>
        <input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <label className="field">
        <span>説明</span>
        <input type="text" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </label>
      <label className="field">
        <span>顧客向け標準案内</span>
        <textarea value={f.clientGuidance} onChange={(e) => setF({ ...f, clientGuidance: e.target.value })} />
      </label>
      <div className="small" style={{ fontWeight: 600 }}>資料リクエスト</div>
      {reqs.map((r, i) => (
        <div key={i} className="row" style={{ marginBottom: 6 }}>
          <input type="text" value={r.title} onChange={(e) => setReqs(reqs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} style={{ flex: 2 }} aria-label="タイトル" />
          <select value={r.kind} onChange={(e) => setReqs(reqs.map((x, j) => (j === i ? { ...x, kind: e.target.value as TemplateReq['kind'] } : x)))} style={{ flex: 1 }} aria-label="種類">
            {Object.entries(REQUEST_KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          {r.kind === 'choice' && (
            <input type="text" placeholder="選択肢をカンマ区切り" value={(r.choices ?? []).join(',')} onChange={(e) => setReqs(reqs.map((x, j) => (j === i ? { ...x, choices: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } : x)))} style={{ flex: 2 }} />
          )}
          <button className="btn small ghost" onClick={() => setReqs(reqs.filter((_, j) => j !== i))} aria-label="削除">
            ✕
          </button>
        </div>
      ))}
      <button className="btn small" onClick={() => setReqs([...reqs, { title: '', kind: 'file', required: true }])}>
        ＋ 資料を追加
      </button>
      <label className="field" style={{ marginTop: 12 }}>
        <span>制作物カテゴリ（1行1項目）</span>
        <textarea value={f.categoriesText} onChange={(e) => setF({ ...f, categoriesText: e.target.value })} />
      </label>
      <label className="field">
        <span>標準確認項目（1行1項目）</span>
        <textarea value={f.checklistText} onChange={(e) => setF({ ...f, checklistText: e.target.value })} />
      </label>
      {error && <div className="alert error">{error}</div>}
      <div className="row">
        <AsyncButton
          className="btn primary"
          onClick={async () => {
            const body = {
              name: f.name,
              description: f.description,
              clientGuidance: f.clientGuidance,
              requests: reqs.filter((r) => r.title.trim()).map((r) => ({ ...r, required: r.required ?? true, choices: r.choices ?? [] })),
              categories: lines(f.categoriesText),
              checklist: lines(f.checklistText),
            };
            try {
              if (t.id) await patch(`/api/app/templates/${t.id}`, body);
              else await post('/api/app/templates', body);
              onSaved();
            } catch (e) {
              setError((e as ApiError).message);
            }
          }}
        >
          保存
        </AsyncButton>
        {t.id && (
          <AsyncButton
            className="btn ghost"
            onClick={async () => {
              if (!confirm('削除しますか？（作成済みの案件には影響しません）')) return;
              await del(`/api/app/templates/${t.id}`);
              onSaved();
            }}
          >
            削除
          </AsyncButton>
        )}
      </div>
    </Modal>
  );
}

export function NotificationsPage() {
  useTitle('通知');
  const st = useApi<{ unread: number; notifications: { id: string; title: string; body: string; link: string; createdAt: string; read: boolean; projectName: string | null }[] }>('/api/app/notifications');
  const nav = useNavigate();
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>通知</h1>
        <AsyncButton
          className="btn small"
          onClick={async () => {
            await post('/api/app/notifications/read', { all: true });
            window.dispatchEvent(new Event('cp:notifications'));
            st.reload();
          }}
        >
          すべて既読
        </AsyncButton>
      </div>
      <Page state={st}>
        {(d) =>
          d.notifications.length === 0 ? (
            <Empty>通知はありません。</Empty>
          ) : (
            <div className="list">
              {d.notifications.map((n) => (
                <button
                  key={n.id}
                  className="item"
                  style={{ textAlign: 'left', cursor: 'pointer', ...(n.read ? { opacity: 0.65 } : { borderColor: 'var(--primary)' }) }}
                  onClick={async () => {
                    if (!n.read) {
                      await post('/api/app/notifications/read', { ids: [n.id] }).catch(() => undefined);
                      window.dispatchEvent(new Event('cp:notifications'));
                    }
                    nav(n.link || '/app');
                  }}
                >
                  <div className="grow">
                    <div className="title">{n.title}</div>
                    {n.body && <div className="small muted pre">{n.body}</div>}
                    <div className="small muted">
                      {fmtDate(n.createdAt)} {n.projectName && `／ ${n.projectName}`}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )
        }
      </Page>
    </div>
  );
}

export function SearchPage() {
  const [sp] = useSearchParams();
  const q = sp.get('q') ?? '';
  useTitle(`検索: ${q}`);
  const st = useApi<{
    projects: { id: string; name: string; statusLabel: string; clientName: string }[];
    clients: { id: string; companyName: string; contactName: string }[];
    files: { id: string; name: string; projectId: string; projectName: string; purpose: string; createdAt: string }[];
    deliverables: { id: string; title: string; projectId: string; projectName: string }[];
  }>(q ? `/api/app/search?q=${encodeURIComponent(q)}` : null, [q]);
  if (!q) return <Empty>検索語を入力してください。</Empty>;
  return (
    <Page state={st}>
      {(d) => (
        <div className="stack">
          <h1>「{q}」の検索結果</h1>
          <h2>案件（{d.projects.length}）</h2>
          <div className="list">
            {d.projects.map((p) => (
              <Link key={p.id} to={`/app/projects/${p.id}`} className="item">
                <div className="grow">
                  <div className="title">{p.name}</div>
                  <div className="muted small">{p.clientName}</div>
                </div>
                <span className="badge info">{p.statusLabel}</span>
              </Link>
            ))}
          </div>
          <h2>顧客（{d.clients.length}）</h2>
          <div className="list">
            {d.clients.map((c) => (
              <Link key={c.id} to={`/app/clients/${c.id}`} className="item">
                <div className="grow">
                  <div className="title">{c.companyName}</div>
                  <div className="muted small">{c.contactName}</div>
                </div>
              </Link>
            ))}
          </div>
          <h2>制作物（{d.deliverables.length}）</h2>
          <div className="list">
            {d.deliverables.map((x) => (
              <Link key={x.id} to={`/app/projects/${x.projectId}/deliverables/${x.id}`} className="item">
                <div className="grow">
                  <div className="title">{x.title}</div>
                  <div className="muted small">{x.projectName}</div>
                </div>
              </Link>
            ))}
          </div>
          <h2>ファイル（{d.files.length}）</h2>
          <div className="list">
            {d.files.map((f) => (
              <a key={f.id} href={`/api/app/projects/${f.projectId}/files/${f.id}/content`} target="_blank" rel="noreferrer" className="item">
                <div className="grow">
                  <div className="title">{f.name}</div>
                  <div className="muted small">
                    {f.projectName} ／ {fmtDate(f.createdAt)} ／ {{ request_attachment: '顧客提出/資料', deliverable_version: '制作物', delivery_extra: '納品', internal: '作業ファイル' }[f.purpose]}
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}

export function SettingsPage() {
  useTitle('設定');
  const me = useMe();
  const toast = useToast();
  const nav = useNavigate();
  const about = useApi<{ appVersion: string; schemaVersion: number; storageDriver: string; mailEnabled: boolean; limits: { maxUploadBytes: number; maxZipBytes: number } }>('/api/app/about');
  const notif = useApi<{ emailEnabled: boolean; mailAvailable: boolean }>('/api/app/notification-settings');
  const [prof, setProf] = useState({ name: me.operator.name, businessName: me.operator.business_name });
  const [pw, setPw] = useState({ current: '', next: '' });
  const [sample, setSample] = useState<{ projectId: string; inviteUrl: string; clientEmail: string } | null>(null);
  return (
    <div className="stack">
      <h1>設定</h1>
      <div className="card">
        <h3>サンプル体験</h3>
        <p className="small muted">
          架空の顧客「Sample Creative株式会社」と案件「秋キャンペーンSNS素材制作」を作成し、資料回収 → ピンコメント → 修正依頼 → v2 → 承認 → 最終納品までの流れを確認できます。サンプルは「サンプル」表示が付き、メールは送信されず、下のボタンでまとめて削除できます。
        </p>
        <div className="row">
          <AsyncButton
            className="btn primary"
            onClick={async () => {
              try {
                const r = await post('/api/app/sample');
                setSample(r);
                toast('サンプル案件を作成しました');
              } catch (e) {
                toast((e as ApiError).message);
              }
            }}
          >
            サンプル案件を作成
          </AsyncButton>
          <AsyncButton
            className="btn"
            onClick={async () => {
              if (!confirm('サンプル案件とサンプル顧客を削除しますか？')) return;
              const r = await del('/api/app/sample');
              toast(`サンプルを削除しました（案件${r.deletedProjects}件）`);
            }}
          >
            サンプルを削除
          </AsyncButton>
        </div>
        {sample && (
          <div className="alert ok small" style={{ marginTop: 10 }}>
            <p>
              <Link to={`/app/projects/${sample.projectId}`}>サンプル案件を開く</Link>
            </p>
            <p>顧客側の画面を体験するには、以下のリンクを別のブラウザ（またはシークレットウィンドウ・スマホ）で開き、メールアドレス {sample.clientEmail} を入力してください。</p>
            <div className="kbd">{sample.inviteUrl}</div>
          </div>
        )}
      </div>
      <div className="card">
        <h3>アカウント</h3>
        <label className="field">
          <span>氏名</span>
          <input type="text" value={prof.name} onChange={(e) => setProf({ ...prof, name: e.target.value })} />
        </label>
        <label className="field">
          <span>屋号・会社名（顧客画面に表示）</span>
          <input type="text" value={prof.businessName} onChange={(e) => setProf({ ...prof, businessName: e.target.value })} />
        </label>
        <AsyncButton className="btn small" onClick={async () => (await patch('/api/auth/me', prof), toast('保存しました'))}>
          保存
        </AsyncButton>
        <div className="muted small" style={{ marginTop: 6 }}>
          ログインID: {me.operator.email}
        </div>
      </div>
      <div className="card">
        <h3>パスワード変更</h3>
        <label className="field">
          <span>現在のパスワード</span>
          <input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        </label>
        <label className="field">
          <span>新しいパスワード（10文字以上）</span>
          <input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        </label>
        <AsyncButton
          className="btn small"
          onClick={async () => {
            try {
              await post('/api/auth/password', pw);
              setPw({ current: '', next: '' });
              toast('パスワードを変更しました（他の端末はログアウトされます）');
            } catch (e) {
              toast((e as ApiError).message);
            }
          }}
        >
          変更
        </AsyncButton>
      </div>
      {notif.data?.mailAvailable && (
        <div className="card">
          <h3>メール通知</h3>
          <label className="check">
            <input type="checkbox" checked={notif.data.emailEnabled} onChange={async (e) => (await api('PUT', '/api/app/notification-settings', { emailEnabled: e.target.checked }), notif.reload())} />
            アプリ内通知と同じ内容をメールでも受け取る
          </label>
        </div>
      )}
      <div className="card">
        <h3>データのエクスポート</h3>
        <p className="small muted">あなたの顧客・案件・資料・制作物・コメント・承認・納品・監査ログ（JSON）とファイル実体をZIPでダウンロードします。容量が大きい場合は時間がかかります。</p>
        <a className="btn small" href="/api/app/export">
          ⬇ 全データをエクスポート
        </a>
      </div>
      <div className="card flat small">
        <h3>このアプリについて</h3>
        {about.data ? (
          <>
            <div>バージョン {about.data.appVersion}（schema {about.data.schemaVersion}）</div>
            <div>ファイル保存先: {about.data.storageDriver === 's3' ? 'S3互換オブジェクトストレージ' : 'サーバーのディスク'}</div>
            <div>メール送信: {about.data.mailEnabled ? '有効' : '無効（招待リンクは手動で送付）'}</div>
            <div>1ファイルの上限: {fmtSize(about.data.limits.maxUploadBytes)} ／ ZIP一括の上限: {fmtSize(about.data.limits.maxZipBytes)}</div>
          </>
        ) : (
          <Loading />
        )}
        <div style={{ marginTop: 8 }}>
          <Link to="/app/templates">テンプレート</Link> ・ <Link to="/app/audit">監査ログ</Link>
        </div>
      </div>
      <button
        className="btn"
        onClick={async () => {
          await post('/api/auth/logout').catch(() => undefined);
          nav('/login');
        }}
      >
        ログアウト
      </button>
    </div>
  );
}

export function AuditPage() {
  useTitle('監査ログ');
  const st = useApi<{ events: { seq: number; projectName: string | null; actorType: string; actorName: string; action: string; summary: string; ipHash: string; userAgent: string; at: string; hash: string }[] }>('/api/app/audit');
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAt?: number } | null>(null);
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>監査ログ</h1>
        <AsyncButton className="btn small" onClick={async () => setVerify(await api('GET', '/api/app/audit/verify'))}>
          改ざんチェック
        </AsyncButton>
      </div>
      <p className="muted small">操作の記録は追記のみで、画面やAPIから変更・削除できません。各記録は前の記録のハッシュを含むため、DBを直接書き換えた場合も「改ざんチェック」で検出できます。招待トークン・パスワード・ファイル内容は記録しません。</p>
      {verify && <div className={`alert ${verify.ok ? 'ok' : 'error'}`}>{verify.ok ? `問題ありません（${verify.checked}件を検証）` : `不一致を検出しました（seq ${verify.brokenAt}）`}</div>}
      <ErrorBox error={st.error} />
      {st.data && (
        <div className="tbl-wrap card">
          <table className="tbl">
            <thead>
              <tr>
                <th>日時</th>
                <th>案件</th>
                <th>操作者</th>
                <th>操作</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {st.data.events.map((e) => (
                <tr key={e.seq}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.at)}</td>
                  <td>{e.projectName ?? '-'}</td>
                  <td>
                    {{ operator: '運営者', client: '顧客', system: '自動', anonymous: '未認証' }[e.actorType] ?? e.actorType} {e.actorName}
                  </td>
                  <td className="small">{e.action}</td>
                  <td className="small">{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

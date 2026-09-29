import { Link } from 'react-router-dom';
import { Empty, Page, fmtDate, useApi, useTitle } from '../../components/ui';

interface Item {
  projectId: string;
  projectName: string;
  clientName: string;
  targetId?: string;
  title: string;
  dueDate?: string | null;
  at?: string | null;
  kind?: string;
}

interface Dash {
  myTurn: { toReviewMaterials: Item[]; changeRequested: Item[]; notSubmitted: Item[]; approvedUndelivered: Item[] };
  clientTurn: { waitingMaterials: Item[]; clientReviewing: Item[] };
  overdue: Item[];
  recent: { projectId: string; projectName: string; actorName: string; actorType: string; summary: string; at: string }[];
}

function link(i: Item, kind: string) {
  if (['changeRequested', 'notSubmitted', 'approvedUndelivered', 'clientReviewing'].includes(kind) && i.targetId) {
    return kind === 'approvedUndelivered' ? `/app/projects/${i.projectId}?tab=deliveries` : `/app/projects/${i.projectId}/deliverables/${i.targetId}`;
  }
  if (kind === 'toReviewMaterials' || kind === 'waitingMaterials') return `/app/projects/${i.projectId}?tab=requests`;
  return `/app/projects/${i.projectId}`;
}

function Bucket({ title, items, kind, hint, tone }: { title: string; items: Item[]; kind: string; hint: string; tone?: string }) {
  return (
    <div className={`card ${tone ?? ''}`} data-testid={`bucket-${kind}`}>
      <div className="row between">
        <h3 style={{ margin: 0 }}>{title}</h3>
        <span className={`badge ${items.length ? 'warn' : ''}`}>{items.length}</span>
      </div>
      <div className="muted small">{hint}</div>
      {items.length > 0 && (
        <div className="list" style={{ marginTop: 8 }}>
          {items.slice(0, 6).map((i, n) => (
            <Link key={`${i.targetId}-${n}`} to={link(i, kind)} className="item" style={{ padding: 8, minHeight: 44 }}>
              <div className="grow">
                <div className="title small">{i.title}</div>
                <div className="muted small">
                  {i.clientName} ／ {i.projectName}
                  {i.dueDate && <> ／ 期限 {fmtDate(i.dueDate)}</>}
                </div>
              </div>
            </Link>
          ))}
          {items.length > 6 && <div className="muted small">ほか {items.length - 6} 件</div>}
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  useTitle('ホーム');
  const st = useApi<Dash>('/api/app/dashboard');
  return (
    <Page state={st}>
      {(d) => {
        const myCount = Object.values(d.myTurn).reduce((s, a) => s + a.length, 0);
        return (
          <div className="stack">
            <div className="row between">
              <h1 style={{ margin: 0 }}>ホーム</h1>
              <Link to="/app/projects?new=1" className="btn primary">
                ＋ 新しい案件
              </Link>
            </div>
            {d.overdue.length > 0 && <Bucket title="⚠ 期限超過" items={d.overdue} kind="overdue" hint="納期・資料提出期限・確認期限を過ぎているもの" tone="danger" />}
            <h2>次に自分がやること（{myCount}）</h2>
            <div className="grid cols-2">
              <Bucket title="提出資料の確認" items={d.myTurn.toReviewMaterials} kind="toReviewMaterials" hint="顧客が提出した資料を確認して「確認済み」か「差戻し」に" />
              <Bucket title="修正依頼あり" items={d.myTurn.changeRequested} kind="changeRequested" hint="修正して新しいversionを提出" />
              <Bucket title="制作物の提出待ち" items={d.myTurn.notSubmitted} kind="notSubmitted" hint="まだ1版も提出していない制作物" />
              <Bucket title="承認済み・未納品" items={d.myTurn.approvedUndelivered} kind="approvedUndelivered" hint="最終納品セットを作成して公開" />
            </div>
            <h2>顧客の対応待ち</h2>
            <div className="grid cols-2">
              <Bucket title="顧客の資料待ち" items={d.clientTurn.waitingMaterials} kind="waitingMaterials" hint="未提出・差戻し中の資料" />
              <Bucket title="顧客の確認待ち" items={d.clientTurn.clientReviewing} kind="clientReviewing" hint="提出済みで承認/修正依頼を待っている版" />
            </div>
            <h2>最近の更新</h2>
            {d.recent.length === 0 ? (
              <Empty>
                まだ更新はありません。まずは <Link to="/app/settings">設定</Link> から「サンプル案件を作成」して流れを体験できます。
              </Empty>
            ) : (
              <ul className="timeline card">
                {d.recent.map((r, i) => (
                  <li key={i}>
                    <Link to={`/app/projects/${r.projectId}`}>{r.projectName}</Link>: {r.summary || r.actorName}
                    <div className="muted small">
                      {fmtDate(r.at)} {r.actorType === 'client' ? `顧客 ${r.actorName}` : r.actorName}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      }}
    </Page>
  );
}

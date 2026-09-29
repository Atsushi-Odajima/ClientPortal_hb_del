import type { DB } from '../db.js';
import { todayYmd } from '../util.js';

/** 顧客ポータル「今やること」と進捗 */
export function clientTodo(db: DB, projectId: string, clientId: string) {
  const reqs = db
    .prepare(
      `SELECT id, title, required, status, due_date FROM document_requests WHERE project_id = ? ORDER BY sort_order, created_at`,
    )
    .all(projectId) as { id: string; title: string; required: number; status: string; due_date: string | null }[];
  const today = todayYmd();
  const needSubmit = reqs.filter((r) => r.status === 'pending' || r.status === 'returned');
  const reviews = db
    .prepare(
      `SELECT d.id deliverable_id, d.title, dv.id version_id, dv.version_number, dv.review_due_date, dv.submitted_at
       FROM deliverables d JOIN deliverable_versions dv ON dv.deliverable_id = d.id
       WHERE d.project_id = ? AND dv.status = 'in_review'
         AND dv.version_number = (SELECT MAX(version_number) FROM deliverable_versions WHERE deliverable_id = d.id)
       ORDER BY dv.submitted_at`,
    )
    .all(projectId) as { deliverable_id: string; title: string; version_id: string; version_number: number; review_due_date: string | null; submitted_at: string }[];
  const deliveries = db
    .prepare(
      `SELECT d.id, d.title, d.published_at, d.expires_at,
        EXISTS (SELECT 1 FROM audit_log a WHERE a.project_id = d.project_id AND a.target_id = d.id
                AND a.action IN ('delivery.downloaded','delivery.zip_downloaded') AND a.actor_type='client' AND a.actor_id = ?) downloaded
       FROM deliveries d WHERE d.project_id = ? AND d.status = 'published' ORDER BY d.published_at DESC`,
    )
    .all(clientId, projectId) as { id: string; title: string; published_at: string; expires_at: string | null; downloaded: number }[];
  const deliverableStats = db
    .prepare(
      `SELECT COUNT(*) total, SUM(CASE WHEN dv.status = 'approved' THEN 1 ELSE 0 END) approved
       FROM deliverables d JOIN deliverable_versions dv ON dv.deliverable_id = d.id
         AND dv.version_number = (SELECT MAX(version_number) FROM deliverable_versions WHERE deliverable_id = d.id)
       WHERE d.project_id = ?`,
    )
    .get(projectId) as { total: number; approved: number | null };
  return {
    requests: {
      total: reqs.length,
      requiredTotal: reqs.filter((r) => r.required).length,
      submitted: reqs.filter((r) => r.status === 'submitted' || r.status === 'accepted').length,
      accepted: reqs.filter((r) => r.status === 'accepted').length,
      toSubmit: needSubmit.map((r) => ({
        id: r.id,
        title: r.title,
        required: !!r.required,
        returned: r.status === 'returned',
        dueDate: r.due_date,
        overdue: !!r.due_date && r.due_date < today,
      })),
    },
    reviews: reviews.map((r) => ({
      deliverableId: r.deliverable_id,
      title: r.title,
      versionId: r.version_id,
      versionNumber: r.version_number,
      reviewDueDate: r.review_due_date,
      overdue: !!r.review_due_date && r.review_due_date < today,
      submittedAt: r.submitted_at,
    })),
    deliverables: { total: deliverableStats.total, approved: deliverableStats.approved ?? 0 },
    deliveries: deliveries.map((d) => ({
      id: d.id,
      title: d.title,
      publishedAt: d.published_at,
      expiresAt: d.expires_at,
      expired: !!d.expires_at && Date.parse(d.expires_at) < Date.now(),
      downloaded: !!d.downloaded,
    })),
  };
}

interface BucketItem {
  projectId: string;
  projectName: string;
  clientName: string;
  targetId?: string;
  title: string;
  dueDate?: string | null;
  at?: string | null;
}

/** 運営者ダッシュボード: 「次に自分がやること」と「顧客待ち」を分離 */
export function operatorDashboard(db: DB, ownerId: string) {
  const today = todayYmd();
  const base = `FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.owner_id = ? AND p.archived_at IS NULL AND p.status NOT IN ('completed','cancelled')`;

  const waitingMaterials = db
    .prepare(
      `SELECT p.id projectId, p.name projectName, c.company_name clientName, r.id targetId, r.title, r.due_date dueDate
       ${base.replace('WHERE', 'JOIN document_requests r ON r.project_id = p.id WHERE')} AND r.status IN ('pending','returned')
       ORDER BY r.due_date IS NULL, r.due_date LIMIT 200`,
    )
    .all(ownerId) as BucketItem[];

  const toReviewMaterials = db
    .prepare(
      `SELECT p.id projectId, p.name projectName, c.company_name clientName, r.id targetId, r.title, r.submitted_at at
       ${base.replace('WHERE', 'JOIN document_requests r ON r.project_id = p.id WHERE')} AND r.status = 'submitted'
       ORDER BY r.submitted_at LIMIT 200`,
    )
    .all(ownerId) as BucketItem[];

  const latestJoin = `JOIN deliverables d ON d.project_id = p.id
    JOIN deliverable_versions dv ON dv.deliverable_id = d.id
      AND dv.version_number = (SELECT MAX(version_number) FROM deliverable_versions WHERE deliverable_id = d.id)`;

  const clientReviewing = db
    .prepare(
      `SELECT p.id projectId, p.name projectName, c.company_name clientName, d.id targetId, d.title || ' v' || dv.version_number title,
              dv.review_due_date dueDate, dv.submitted_at at
       ${base.replace('WHERE', `${latestJoin} WHERE`)} AND dv.status = 'in_review' ORDER BY dv.submitted_at LIMIT 200`,
    )
    .all(ownerId) as BucketItem[];

  const changeRequested = db
    .prepare(
      `SELECT p.id projectId, p.name projectName, c.company_name clientName, d.id targetId, d.title || ' v' || dv.version_number title,
              (SELECT MAX(created_at) FROM change_requests cr WHERE cr.version_id = dv.id) at
       ${base.replace('WHERE', `${latestJoin} WHERE`)} AND dv.status = 'changes_requested' ORDER BY at LIMIT 200`,
    )
    .all(ownerId) as BucketItem[];

  const notSubmitted = db
    .prepare(
      `SELECT p.id projectId, p.name projectName, c.company_name clientName, d.id targetId, d.title, p.due_date dueDate
       ${base.replace('WHERE', 'JOIN deliverables d ON d.project_id = p.id WHERE')}
         AND NOT EXISTS (SELECT 1 FROM deliverable_versions dv WHERE dv.deliverable_id = d.id)
       ORDER BY p.due_date IS NULL, p.due_date LIMIT 200`,
    )
    .all(ownerId) as BucketItem[];

  const approvedUndelivered = db
    .prepare(
      `SELECT p.id projectId, p.name projectName, c.company_name clientName, d.id targetId, d.title || ' v' || dv.version_number title,
              (SELECT approved_at FROM approvals a WHERE a.version_id = dv.id AND a.revoked_at IS NULL) at
       ${base.replace('WHERE', `${latestJoin} WHERE`)} AND dv.status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM delivery_items di JOIN deliveries dl ON dl.id = di.delivery_id
                         WHERE di.version_id = dv.id AND dl.status = 'published')
       ORDER BY at LIMIT 200`,
    )
    .all(ownerId) as BucketItem[];

  const overdue: (BucketItem & { kind: string })[] = [
    ...(db
      .prepare(
        `SELECT p.id projectId, p.name projectName, c.company_name clientName, p.id targetId, '納期: ' || p.name title, p.due_date dueDate, 'project' kind
         ${base} AND p.due_date IS NOT NULL AND p.due_date < ? AND p.status NOT IN ('delivered') LIMIT 100`,
      )
      .all(ownerId, today) as (BucketItem & { kind: string })[]),
    ...(db
      .prepare(
        `SELECT p.id projectId, p.name projectName, c.company_name clientName, r.id targetId, '資料: ' || r.title title, r.due_date dueDate, 'request' kind
         ${base.replace('WHERE', 'JOIN document_requests r ON r.project_id = p.id WHERE')}
           AND r.status IN ('pending','returned') AND r.due_date IS NOT NULL AND r.due_date < ? LIMIT 100`,
      )
      .all(ownerId, today) as (BucketItem & { kind: string })[]),
    ...(db
      .prepare(
        `SELECT p.id projectId, p.name projectName, c.company_name clientName, d.id targetId, '確認: ' || d.title || ' v' || dv.version_number title,
                dv.review_due_date dueDate, 'review' kind
         ${base.replace('WHERE', `${latestJoin} WHERE`)} AND dv.status = 'in_review' AND dv.review_due_date IS NOT NULL AND dv.review_due_date < ? LIMIT 100`,
      )
      .all(ownerId, today) as (BucketItem & { kind: string })[]),
  ];

  const recent = db
    .prepare(
      `SELECT a.project_id projectId, p.name projectName, a.actor_name actorName, a.actor_type actorType, a.action, a.summary, a.created_at at
       FROM audit_log a JOIN projects p ON p.id = a.project_id
       WHERE a.owner_id = ? AND p.archived_at IS NULL AND a.action NOT LIKE 'operator.%' AND a.action NOT IN ('invite.email_mismatch')
       ORDER BY a.seq DESC LIMIT 20`,
    )
    .all(ownerId);

  return {
    myTurn: { toReviewMaterials, changeRequested, notSubmitted, approvedUndelivered },
    clientTurn: { waitingMaterials, clientReviewing },
    overdue,
    recent,
  };
}

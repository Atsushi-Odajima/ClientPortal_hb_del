// サーバー・画面で共有する表示ラベル

export const PROJECT_STATUSES = [
  'preparing',
  'waiting_materials',
  'in_production',
  'client_review',
  'revising',
  'approved',
  'delivered',
  'completed',
  'on_hold',
  'cancelled',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** 運営者向け（内部）状態名 */
export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  preparing: '準備中',
  waiting_materials: '資料待ち',
  in_production: '制作中',
  client_review: '顧客確認中',
  revising: '修正中',
  approved: '承認済み',
  delivered: '納品済み',
  completed: '完了',
  on_hold: '保留',
  cancelled: 'キャンセル',
};

/** 顧客向けの既定表示（運営者が案件ごとに上書き可能） */
export const PROJECT_STATUS_CLIENT_LABEL: Record<ProjectStatus, string> = {
  preparing: '準備中',
  waiting_materials: '資料のご提出をお願いしています',
  in_production: '制作中',
  client_review: 'ご確認をお願いしています',
  revising: '修正対応中',
  approved: '承認いただきました',
  delivered: '納品済み',
  completed: '完了',
  on_hold: '一時停止中',
  cancelled: '終了',
};

export const REQUEST_KIND_LABEL = {
  file: 'ファイル',
  text: 'テキスト',
  url: 'URL',
  choice: '選択肢',
  check: '確認チェック',
} as const;

export const REQUEST_STATUS_LABEL = {
  pending: '未提出',
  submitted: '提出済み',
  returned: '差戻し',
  accepted: '確認済み',
} as const;

export const VERSION_STATUS_LABEL = {
  in_review: '確認待ち',
  changes_requested: '修正依頼あり',
  approved: '承認済み',
  superseded: '旧版',
} as const;

export const DELIVERY_STATUS_LABEL = {
  draft: '下書き',
  published: '公開中',
  withdrawn: '取り下げ',
} as const;

export const PORTAL_STATUS_LABEL = {
  draft: '非公開（準備中）',
  published: '公開中',
  closed: '終了（顧客アクセス不可）',
} as const;

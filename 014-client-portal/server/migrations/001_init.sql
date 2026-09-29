-- Client Portal schema v1
-- すべてのIDはアプリ側で生成する推測困難なランダムID（prefix + 22文字 base62 ≒ 131bit）
-- 日時は ISO8601 UTC 文字列

CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  business_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE operator_sessions (
  id_hash TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_operator_sessions_operator ON operator_sessions(operator_id);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL COLLATE NOCASE,
  phone TEXT NOT NULL DEFAULT '',
  internal_memo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_clients_owner ON clients(owner_id, status, company_name);
CREATE INDEX idx_clients_email ON clients(email);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  client_guidance TEXT NOT NULL DEFAULT '',
  requests_json TEXT NOT NULL DEFAULT '[]',
  categories_json TEXT NOT NULL DEFAULT '[]',
  checklist_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_templates_owner ON templates(owner_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN (
    'preparing','waiting_materials','in_production','client_review','revising',
    'approved','delivered','completed','on_hold','cancelled')),
  client_status_label TEXT NOT NULL DEFAULT '',
  client_guidance TEXT NOT NULL DEFAULT '',
  internal_memo TEXT NOT NULL DEFAULT '',
  portal_status TEXT NOT NULL DEFAULT 'draft' CHECK (portal_status IN ('draft','published','closed')),
  categories_json TEXT NOT NULL DEFAULT '[]',
  checklist_json TEXT NOT NULL DEFAULT '[]',
  template_id TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_owner ON projects(owner_id, archived_at, updated_at);
CREATE INDEX idx_projects_owner_status ON projects(owner_id, status);
CREATE INDEX idx_projects_client ON projects(client_id);
CREATE INDEX idx_projects_owner_due ON projects(owner_id, due_date);

CREATE TABLE project_status_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by_type TEXT NOT NULL,
  changed_by_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL
);
CREATE INDEX idx_psh_project ON project_status_history(project_id, changed_at);

-- 顧客ごとの案件アクセス権（招待で付与、運営者が停止可能）
CREATE TABLE portal_access (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (project_id, client_id)
);
CREATE INDEX idx_portal_access_client ON portal_access(client_id, status);

-- 招待トークン（平文は保存しない。SHA-256ハッシュのみ）
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  access_id TEXT NOT NULL REFERENCES portal_access(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'invite' CHECK (kind IN ('invite','magic')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invites_access ON invites(access_id);

CREATE TABLE client_sessions (
  id_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  invite_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_client_sessions_client ON client_sessions(client_id);

CREATE TABLE document_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('file','text','url','choice','check')),
  required INTEGER NOT NULL DEFAULT 1,
  due_date TEXT,
  choices_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','returned','accepted')),
  answer_text TEXT,
  answer_url TEXT,
  answer_choice TEXT,
  answer_checked INTEGER,
  submitted_at TEXT,
  submitted_by TEXT,
  reviewed_at TEXT,
  return_reason TEXT NOT NULL DEFAULT '',
  internal_memo TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_requests_project ON document_requests(project_id, sort_order);
CREATE INDEX idx_requests_status ON document_requests(status);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  uploader_type TEXT NOT NULL CHECK (uploader_type IN ('operator','client')),
  uploader_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('request_attachment','deliverable_version','delivery_extra','internal')),
  request_id TEXT REFERENCES document_requests(id) ON DELETE SET NULL,
  version_group_id TEXT,
  version_number INTEGER,
  preview_kind TEXT NOT NULL DEFAULT 'none' CHECK (preview_kind IN ('image','pdf','video','none')),
  width INTEGER,
  height INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_files_project ON files(project_id, created_at);
CREATE INDEX idx_files_owner_name ON files(owner_id, original_name);
CREATE INDEX idx_files_request ON files(request_id);

-- 制作物（= versionGroup）
CREATE TABLE deliverables (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_deliverables_project ON deliverables(project_id, sort_order);

CREATE TABLE deliverable_versions (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  file_id TEXT NOT NULL REFERENCES files(id),
  note TEXT NOT NULL DEFAULT '',
  checklist_json TEXT NOT NULL DEFAULT '[]',
  review_due_date TEXT,
  status TEXT NOT NULL DEFAULT 'in_review' CHECK (status IN ('in_review','changes_requested','approved','superseded')),
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  UNIQUE (deliverable_id, version_number)
);
CREATE INDEX idx_versions_project ON deliverable_versions(project_id, status);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES deliverable_versions(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('operator','client')),
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  pin_x REAL,
  pin_y REAL,
  pin_number INTEGER,
  resolved_at TEXT,
  resolved_by TEXT,
  edited_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_comments_version ON comments(version_id, created_at);
CREATE INDEX idx_comments_project ON comments(project_id);

-- 修正依頼（固定記録。編集・削除APIなし）
CREATE TABLE change_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES deliverable_versions(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  body TEXT NOT NULL,
  pin_comment_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_change_requests_version ON change_requests(version_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES deliverable_versions(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  file_id TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  user_agent TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  approved_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_type TEXT,
  revoked_by_id TEXT,
  revoke_reason TEXT
);
-- 1つのversionに有効な承認は1件のみ（二重承認防止）
CREATE UNIQUE INDEX uq_approvals_active ON approvals(version_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_approvals_project ON approvals(project_id);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  notice TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','withdrawn')),
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_deliveries_project ON deliveries(project_id);

CREATE TABLE delivery_items (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  version_id TEXT REFERENCES deliverable_versions(id),
  approval_id TEXT REFERENCES approvals(id),
  file_id TEXT NOT NULL REFERENCES files(id),
  label TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_delivery_items_delivery ON delivery_items(delivery_id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('operator','client')),
  recipient_id TEXT NOT NULL,
  project_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX idx_notifications_recipient ON notifications(recipient_type, recipient_id, read_at, created_at);
CREATE INDEX idx_notifications_project ON notifications(project_id);

CREATE TABLE notification_settings (
  recipient_type TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  email_enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (recipient_type, recipient_id)
);

CREATE TABLE mail_outbox (
  id TEXT PRIMARY KEY,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

-- 分割アップロードの一時管理（完了後に files へ）
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  declared_mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  received_json TEXT NOT NULL DEFAULT '[]',
  target_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','completing','completed','failed','aborted')),
  error_code TEXT NOT NULL DEFAULT '',
  file_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_uploads_expires ON uploads(status, expires_at);

-- 監査ログ（追記のみ。UPDATEは常に禁止、DELETEは保守モード時のみ）
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  owner_id TEXT,
  project_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  client_visible INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  ip_hash TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX idx_audit_owner ON audit_log(owner_id, seq);
CREATE INDEX idx_audit_project ON audit_log(project_id, seq);

CREATE TABLE maintenance_flags (
  name TEXT PRIMARY KEY
);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
WHEN NOT EXISTS (SELECT 1 FROM maintenance_flags WHERE name = 'audit_purge')
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- 承認済みversionのファイル差替え禁止
CREATE TRIGGER versions_no_file_change BEFORE UPDATE OF file_id, version_number, deliverable_id ON deliverable_versions
BEGIN
  SELECT RAISE(ABORT, 'version file is immutable; submit a new version');
END;

-- 承認記録の本体は変更禁止（取消情報の追記のみ可）
CREATE TRIGGER approvals_immutable BEFORE UPDATE OF version_id, client_id, file_sha256, approved_at, file_id, version_number ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approval record is immutable');
END;

-- 修正依頼は変更禁止
CREATE TRIGGER change_requests_no_update BEFORE UPDATE ON change_requests
BEGIN
  SELECT RAISE(ABORT, 'change request is immutable');
END;

-- ファイル実体情報は変更禁止
CREATE TRIGGER files_immutable BEFORE UPDATE OF storage_key, sha256, size, project_id ON files
BEGIN
  SELECT RAISE(ABORT, 'file record is immutable');
END;

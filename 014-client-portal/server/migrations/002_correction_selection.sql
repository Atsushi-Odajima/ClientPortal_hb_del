-- migrate:foreign-keys-off
-- Client Portal schema v2: 修正指示（ピンの指示タイプ）と 写真セレクト
-- files.purpose の CHECK 制約に 'selection_photo' を追加するため files を作り直す
-- （SQLite の推奨手順: 外部キーを無効にして新テーブルへ複製 → 旧テーブル削除 → 改名 → foreign_key_check）

-- 1) Client Portal 修正指示: ピンコメントの指示タイプ（元ツールの 変更/削除/追加/移動/変更しない/その他）
ALTER TABLE comments ADD COLUMN pin_type TEXT CHECK (pin_type IS NULL OR pin_type IN ('change','delete','add','move','keep','other'));
UPDATE comments SET pin_type = 'change' WHERE pin_number IS NOT NULL;

-- 2) files: purpose に selection_photo を追加
CREATE TABLE files_v2 (
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
  purpose TEXT NOT NULL CHECK (purpose IN ('request_attachment','deliverable_version','delivery_extra','internal','selection_photo')),
  request_id TEXT REFERENCES document_requests(id) ON DELETE SET NULL,
  version_group_id TEXT,
  version_number INTEGER,
  preview_kind TEXT NOT NULL DEFAULT 'none' CHECK (preview_kind IN ('image','pdf','video','none')),
  width INTEGER,
  height INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  created_at TEXT NOT NULL
);
INSERT INTO files_v2 (id, project_id, owner_id, uploader_type, uploader_id, original_name, storage_key, mime, size, sha256, purpose, request_id,
  version_group_id, version_number, preview_kind, width, height, status, created_at)
SELECT id, project_id, owner_id, uploader_type, uploader_id, original_name, storage_key, mime, size, sha256, purpose, request_id,
  version_group_id, version_number, preview_kind, width, height, status, created_at FROM files;
DROP TABLE files;
ALTER TABLE files_v2 RENAME TO files;
CREATE INDEX idx_files_project ON files(project_id, created_at);
CREATE INDEX idx_files_owner_name ON files(owner_id, original_name);
CREATE INDEX idx_files_request ON files(request_id);
CREATE TRIGGER files_immutable BEFORE UPDATE OF storage_key, sha256, size, project_id ON files
BEGIN
  SELECT RAISE(ABORT, 'file record is immutable');
END;

-- 3) Client Portal 写真セレクト
-- セット: draft（準備中・顧客に非表示）→ open（顧客が選択可能）→ closed（受付終了・閲覧のみ）
CREATE TABLE selection_sets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  show_names INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  opened_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_selection_sets_project ON selection_sets(project_id, created_at);

-- 写真: 番号 = position（1始まり）。公開（open）後は並べ替え・削除不可（番号が変わらないことを保証）
CREATE TABLE selection_photos (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES selection_sets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL UNIQUE REFERENCES files(id),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (set_id, position)
);
CREATE INDEX idx_selection_photos_project ON selection_photos(project_id);

-- 顧客ごとの選択（保存した時点の内容。送信＝selection_responses.submitted_at）
CREATE TABLE selection_picks (
  set_id TEXT NOT NULL REFERENCES selection_sets(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  photo_id TEXT NOT NULL REFERENCES selection_photos(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (set_id, client_id, photo_id)
);

CREATE TABLE selection_responses (
  set_id TEXT NOT NULL REFERENCES selection_sets(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  picks_updated_at TEXT,
  submitted_at TEXT,
  submitted_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (set_id, client_id)
);

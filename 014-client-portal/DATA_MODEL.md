# DATA_MODEL — データモデル

正本: `server/migrations/001_init.sql` + `002_correction_selection.sql`（schemaVersion 2）。IDは `prefix_` + base62 22文字（約131bit, 推測困難）。日時は ISO8601 UTC、日付は `YYYY-MM-DD`。

## ER 概要

```
operators 1─* clients 1─* projects 1─* document_requests 1─* files(request_attachment)
    │                         │
    │                         ├─* portal_access *─1 clients      （招待で付与・停止可能）
    │                         │        └─* invites               （token_hash のみ保存）
    │                         ├─* deliverables(=versionGroup) 1─* deliverable_versions 1─1 files
    │                         │                                        ├─* comments（ピン座標 0..1）
    │                         │                                        ├─* change_requests（不変）
    │                         │                                        └─* approvals（不変・取消は追記）
    │                         ├─* deliveries 1─* delivery_items ─ version / approval / file
    │                         ├─* selection_sets 1─* selection_photos 1─1 files(selection_photo)
    │                         │        ├─* selection_picks（顧客×写真）
    │                         │        └─* selection_responses（顧客ごとの送信）
    │                         └─* project_status_history
    ├─* templates
    └─ audit_log（追記専用・ハッシュチェーン）/ notifications / mail_outbox
```

## 主なテーブル

| テーブル | 主な列 | 備考 |
|---|---|---|
| operators | id, email(UNIQUE NOCASE), name, business_name, password_hash(scrypt), status | 運営者 |
| operator_sessions / client_sessions | id_hash(SHA-256), 期限, last_seen | Cookieの生値は保存しない |
| clients | id, owner_id, company_name, contact_name, email, phone, internal_memo, status(active/archived), is_sample | internal_memo は顧客APIに一切出さない |
| projects | id, owner_id, client_id, name, description, start_date, due_date, status(10種), client_status_label, client_guidance, internal_memo, portal_status(draft/published/closed), categories_json, checklist_json, template_id, is_sample, archived_at | 顧客表示状態は client_status_label（空なら既定ラベル） |
| project_status_history | from/to, changed_by_type(operator/system), note | 状態履歴 |
| portal_access | project_id, client_id, status(active/revoked) | 顧客×案件のアクセス権 |
| invites | access_id, kind(invite/magic), token_hash, expires_at, revoked_at, max_uses, use_count, failed_attempts | |
| document_requests | kind(file/text/url/choice/check), required, due_date, choices_json, status(pending/submitted/returned/accepted), answer_*, return_reason, internal_memo | 提出(submitted)と確認(accepted)を分離 |
| files | project_id, uploader_type/id, original_name, storage_key, mime, size, sha256, purpose(request_attachment/deliverable_version/delivery_extra/internal/selection_photo), request_id, version_group_id, version_number, preview_kind, width, height, status(active/withdrawn) | storage_key/sha256/size は不変（トリガー） |
| deliverables | title, category, description | versionGroup |
| deliverable_versions | deliverable_id, version_number(UNIQUE per deliverable), file_id, note, checklist_json, review_due_date, status(in_review/changes_requested/approved/superseded), submitted_by/at | file_id 等は不変（トリガー） |
| comments | version_id, parent_id(返信), author_type/id/name, body, pin_x/pin_y(0..1 元画像比), pin_number, pin_type, resolved_at, edited_at, deleted_at | 削除は論理削除。pin_type（v2, Client Portal 修正指示）: change/delete/add/move/keep/other、ピンなしは NULL |
| change_requests | version_id, client_id, client_name, body, pin_comment_ids_json | 不変（UPDATE禁止トリガー） |
| approvals | version_id, version_number, client_id, file_id, file_sha256, comment, idempotency_key(UNIQUE), approved_at, revoked_at/by/reason | 有効承認は1版1件（部分UNIQUE）、本体列は不変 |
| deliveries | title, description, notice, expires_at, status(draft/published/withdrawn), published_at | |
| delivery_items | delivery_id, version_id, approval_id, file_id, label | 追加納品ファイルは version_id NULL |
| selection_sets | project_id, title, message, show_names, status(draft/open/closed), opened_at, closed_at | Client Portal 写真セレクト（v2）。draft は顧客に非表示 |
| selection_photos | set_id, project_id, file_id(UNIQUE), position(UNIQUE per set) | 番号 = position。公開後は並べ替え・削除不可 |
| selection_picks | PK(set_id, client_id, photo_id) | 顧客の現在の選択（クリック・番号入力の都度保存） |
| selection_responses | PK(set_id, client_id), client_name, note, picks_updated_at, submitted_at, submitted_count | 送信記録。picks_updated_at > submitted_at なら「送信後に変更あり」 |
| notifications | recipient_type/id, kind, title, body, link, dedupe_key(UNIQUE), read_at | アプリ内通知 |
| mail_outbox | to, subject, body_text, status, attempts, dedupe_key | 送信後本文消去 |
| uploads | 分割アップロードの一時管理（chunk_size, received_json, target_json, status） | 完了後7日/期限切れで掃除 |
| templates | requests_json, categories_json, checklist_json, client_guidance | 案件作成時に複製 |
| audit_log | seq, owner_id, project_id, actor_type/id/name, action, target, client_visible, summary, detail_json, ip_hash, user_agent, prev_hash, hash | UPDATE/DELETE禁止トリガー |

## 状態遷移

- 案件: preparing → waiting_materials → in_production → client_review ⇄ revising → approved → delivered → completed（on_hold / cancelled は任意）。
  自動遷移: 版提出→client_review、修正依頼→revising、全制作物の最新版承認→approved、納品公開→delivered。運営者はいつでも手動変更可（履歴に記録）。
- 資料: pending →(顧客提出) submitted →(運営者) accepted / returned →(再提出) submitted
- 版: in_review →(修正依頼) changes_requested / (承認) approved；新版提出で直前版は superseded；承認取消で最新版は in_review に戻る
- 納品: draft →(公開・承認再検証) published →(取り下げ) withdrawn
- 写真セレクト: draft（並べ替え・削除可）→(公開・顧客へ通知) open（顧客が選択・送信）⇄ closed（受付終了・閲覧のみ）

## 削除・アーカイブの仕様
| 対象 | アーカイブ | 削除 |
|---|---|---|
| 顧客 | status=archived（全セッション破棄、ポータル不可） | 案件がある顧客は削除不可（原則アーカイブ） |
| 案件 | archived_at（顧客アクセス不可、一覧から非表示） | 案件名の入力で確認後、DB行（監査ログ以外）とストレージ実体を削除 |
| ファイル | — | 提出済み版・公開納品のファイルは取り下げ不可（履歴保持）。未提出の添付・内部ファイルは withdrawn |
| 監査ログ | — | 通常不可。保守手順のみ（OPERATIONS.md） |

## 設定値（将来変更可能）
環境変数で変更（server/src/config.ts）: MAX_UPLOAD_MB, CHUNK_MB, MAX_ACTIVE_PROJECTS, MAX_PROJECT_STORAGE_MB, MAX_ZIP_MB, INVITE_DEFAULT_DAYS, INVITE_MAX_DAYS, CLIENT_SESSION_DAYS, SIGNED_URL_SECONDS ほか。料金・単価はコードに埋め込まない。

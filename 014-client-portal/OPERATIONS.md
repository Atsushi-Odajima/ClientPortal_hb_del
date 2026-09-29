# OPERATIONS — 運用手順（バックアップ・復元・更新・削除）

## 1. バックアップ

### 取得
```
npm run backup -- /path/to/backups            # ソースから動かしている場合
docker compose exec app node dist/scripts/backup.js /backups   # Docker
fly ssh console -C "node /app/dist/scripts/backup.js /data/backups"  # Fly.io（Volume内。別の場所へ持ち出すこと）
```
- 稼働中に実行可能（SQLite オンラインバックアップAPIで一貫したスナップショットを取得）。
- 出力: `cp-backup-<日時>/`（`manifest.json`, `db.sqlite`, `objects/`）。途中で失敗した場合は `.partial` を削除し何も残さない。
- manifest には `format`, `formatVersion`, `appVersion`, `schemaVersion`, `createdAt`, 各テーブル件数, `fileCount`, `totalBytes`, DBとファイルごとの SHA-256, 監査ログチェーン検証結果を記録。
- **DBとファイルの対応**: DBスナップショットを先に取り、そのDBが参照するファイルだけを複製してハッシュ照合する。バックアップ中に新規アップロードされたファイルは含まれない（DBにも含まれないため整合する）。
- S3ドライバの場合もファイル実体をダウンロードして同じ形式で保存する。

### 推奨運用
- 毎日1回 cron 等で取得し、**サーバーとは別の場所**（別クラウド・手元PC・外部ストレージ）へコピー。
  例（VPS）: `0 3 * * * cd /opt/portal && docker compose exec -T app node dist/scripts/backup.js /backups && find ./backups -maxdepth 1 -name 'cp-backup-*' -mtime +14 -exec rm -rf {} +`
- 保持: 14日分など世代数を決める（容量＝ファイル総量×世代数。OPERATING_COSTS.md）。
- Fly.io の Volume スナップショット（日次・既定5日）は「同じ基盤内」の補助。アプリのバックアップも別途取得すること。
- 月1回は下記「復元テスト」を空環境で実施。

## 2. 復元
```
# 1) 検証のみ（現行データは触らない）
npm run restore -- /path/to/backups/cp-backup-XXXX --verify-only
# 2) サーバーを停止
# 3) 復元
npm run restore -- /path/to/backups/cp-backup-XXXX
# 4) サーバーを起動し、ログイン・案件・ファイルを確認
```
- 検証: manifest形式・schemaVersion・DBハッシュ・`PRAGMA integrity_check`・外部キー・件数一致・全ファイルのサイズとSHA-256・DBとmanifestの対応・監査ログのハッシュチェーン。
- 手順: ステージングディレクトリ（`<DATA_DIR>.restore-staging-*`）に構築 → 最終検証 → 現行 `DATA_DIR` を `<DATA_DIR>.before-restore-<日時>` へ退避 → 入れ替え。**どの段階で失敗しても現行データは変更されない**（入替失敗時は元に戻す）。
- 退避したデータは動作確認後に手動で削除。
- 古い schemaVersion のバックアップは復元時に自動マイグレーション。新しい schemaVersion のバックアップは古いアプリには復元不可（アプリを更新してから）。
- S3ドライバ: ファイルは先にバケットへアップロード（キーは不変IDのため既存を壊さない）→ DBを入れ替え。
- 復元テスト: tests/backup-audit.test.ts, tests/s3.test.ts, e2e E2E-7 で「案件・version・ファイル・コメント・承認ハッシュ・納品」の一致を確認済み（TEST_REPORT.md）。

## 3. アップデート
1. バックアップ取得 → 2. 新しい版に入れ替え（`fly deploy` / `docker compose up -d --build`）→ 3. 起動時にマイグレーション自動適用 → 4. `/api/health` とログイン確認。
問題があれば旧版に戻し、必要ならバックアップから復元。

## 4. 監視・日常確認
- ヘルスチェック: `GET /api/health`。
- ログ: 標準出力（JSON）。トークン・Cookie・パスワードは出力しない。
- 定期ジョブ（アプリ内）: メール送信（30秒）、期限超過通知（1時間, 1日1回/対象）、一時ファイル・期限切れセッション・送信済みメール本文の掃除（1時間）。
- ディスク使用量: 設定画面の容量上限（MAX_PROJECT_STORAGE_MB など）と、サーバーの空き容量を定期確認。
- 監査ログの改ざんチェック: 運営画面「監査ログ」→「改ざんチェック」。

## 5. 削除・アーカイブとデータの扱い
| 操作 | DB | ストレージ | バックアップ |
|---|---|---|---|
| 案件アーカイブ | 残る（顧客アクセス不可） | 残る | 残る |
| 案件削除 | 監査ログ以外を削除 | 実体を削除（失敗分は孤立ファイル） | **既存バックアップには残る**。保持期間経過で消える |
| 顧客アーカイブ | 残る（全セッション破棄） | — | 残る |
| 顧客削除 | 案件がない場合のみ削除 | — | 残る |
| ファイル取り下げ | 非表示（履歴保持） | 残る（案件削除時に削除） | 残る |
| サンプル削除 | サンプル案件・顧客を削除 | 削除 | 残る |

- 顧客から完全削除を求められた場合: 案件削除 → 顧客削除 → 必要なら古いバックアップを削除、監査ログは `npm run purge-audit -- --owner <運営者ID>` または `--before <日付>`（保守用。実行前にバックアップ）。
- 孤立ファイル: `npm run gc-orphans`（一覧）→ `npm run gc-orphans -- --delete`（削除）。
- 全データエクスポート: 運営画面「設定」→「全データをエクスポート」（自分のデータ＋ファイル実体のZIP）。

## 6. アカウント・アクセスの緊急対応
- 招待リンクが漏れた: 案件「共有・招待」→ 該当リンクを「失効」、必要なら「アクセスを停止」→ 新しいリンクを発行。
- 顧客の端末紛失: 顧客詳細「全案件のアクセスを停止」（全セッション破棄・招待失効）→ 再招待。
- 運営者パスワード漏えい: 設定でパスワード変更（全端末ログアウト）。ログインできない場合はサーバーで `npm run create-operator` により別アカウントを作成し、DBの確認は開発者へ依頼。
- SESSION_SECRET を変更すると IP ハッシュの対応が変わる（セッションは影響なし）。

## 7. 設定値の変更
環境変数で変更し再起動（DATA_MODEL.md「設定値」）。上限を下げても既存ファイルは削除されない。

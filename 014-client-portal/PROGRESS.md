# PROGRESS

最終更新: 2026-10-07

| Phase | 内容 | 状態 | 備考 |
|---|---|---|---|
| 0 | 技術/料金/ライセンス選定、最小PWA、ファイル保存PoC | 完了 | 料金は一部[未検証]（公式ページに到達できず）。実機確認は未検証 |
| 1 | 認証、運営者/顧客、案件、招待、認可 | 完了 | |
| 2 | 資料リクエスト、顧客ポータル、通知 | 完了 | メールは dev-file ドライバで検証、実SMTP未検証 |
| 3 | アップロード、プレビュー、version管理 | 完了 | HEIC/MOV実機未検証 |
| 4 | コメント、画像ピン、修正依頼 | 完了 | |
| 5 | 承認、取消、監査履歴、競合防止 | 完了 | |
| 6 | 最終納品、ZIP、期限付きダウンロード | 完了 | ZIPは同期ストリーミング（上限 MAX_ZIP_MB） |
| 7 | テンプレート、検索、ダッシュボード、エクスポート | 完了 | |
| 8 | バックアップ/復元、負荷、セキュリティ | 完了 | 外部診断は未実施 |
| 9 | PWA、E2E、説明書、デプロイ、販売前チェック | 一部未検証 | E2E・資料・デプロイ設定は完了。**実機確認・実デプロイ（Docker/Fly）は未検証** → RELEASE_CHECKLIST B |
| 10 | 単体ツール統合（Client Portal 修正指示 / Client Portal 写真セレクト） | 完了 | DECISIONS D12。実機・印刷の見た目は未検証 |

## 統合の引き継ぎ（FreelanceDesk への統合担当向け）
- 新テーブル: selection_sets / selection_photos / selection_picks / selection_responses。既存変更: comments.pin_type、files.purpose に selection_photo（migration 002, SCHEMA_VERSION=2）。
- 新ルート: server/src/routes/selections.ts（運営者・顧客の写真セレクトAPI）、server/src/routes/corrections.ts（修正指示書API）。サービス: server/src/services/selection.ts。共有ロジック: shared/photoSelect.ts, shared/correctionSheet.ts。
- 新画面: web/src/pages/op/SelectionOp.tsx（タブ「写真セレクト」・セット詳細）、web/src/pages/portal/PortalSelect.tsx、web/src/components/CorrectionSheet.tsx（運営者/顧客共通の修正指示書）。既存の Review.tsx にピン指示タイプ選択・定型文・修正指示書リンクを追加。
- API一覧・画面パス・通知種別・監査アクションは DECISIONS.md D12-3。

## 履歴
- 2026-09-29: サーバー実装・API統合テスト → フロントエンド（運営者/顧客/PWA）→ E2E 10件 → S3互換テスト・負荷試験・デモ・保守CLI → 資料一式。
- 2026-10-07: 単体ツール2本（画像 修正指示メーカー・写真セレクト一覧メーカー）を統合。ピン指示タイプ・修正指示書、写真セレクト（番号付け・番号入力・CSV）、migration 002、統合テスト29件・E2E 2件を追加。

# PLAN — 商品 #014 Client Portal

顧客専用ページで「資料回収 → 制作物提出 → コメント/修正依頼 → 新version → 承認 → 最終納品 → アーカイブ」を1か所にまとめる、1人〜小規模事業者向けのセルフホスト型Webアプリ（PWA）。

## スコープ

対象: 案件・顧客・招待・資料リクエスト・ファイル・制作物version・コメント/画像ピン・修正依頼・承認/取消・最終納品/ZIP・監査ログ・アプリ内通知・テンプレート・ダッシュボード/検索・エクスポート・バックアップ/復元・PWA。

対象外（今回広げない）: 見積、請求、入金、会計、在庫、EC、電子契約保証、汎用チャット、ビデオ会議、PDF高度注釈、動画タイムコード注釈、AI機能、複数スタッフ詳細権限、顧客への決済請求。#012 Freelance Desk の領域（見積・請求・入金）は扱わない。

## アーキテクチャ概要

```
[ブラウザ / iPhone Safari PWA / Android Chrome PWA]
      │  HTTPS（Cookieセッション, CSRFヘッダ）
      ▼
[Node.js 22 + Fastify 5 （1プロセス）] ── 静的配信: React SPA (Vite build) + Service Worker
      │                 │
      ▼                 ▼
 SQLite (WAL)     ストレージドライバ
 (永続ディスク)    ├ local: DATA_DIR/objects（永続ディスク）
                   └ s3: S3互換（Cloudflare R2 / S3 / B2）非公開バケット + 期限付きURL
```

- 詳細: DECISIONS.md / DATA_MODEL.md / SECURITY.md / FILE_STORAGE.md / OPERATIONS.md / OPERATING_COSTS.md

## Phase 計画と完了条件

| Phase | 内容 | 完了条件 |
|---|---|---|
| 0 | 技術/料金/ライセンス選定、最小PWA、ファイル保存PoC | DECISIONS/OPERATING_COSTS 記載、ローカル/ S3互換ドライバのテスト |
| 1 | 認証、運営者/顧客、案件、招待、認可 | 認可テスト（A→B拒否）合格 |
| 2 | 資料リクエスト、顧客ポータル、通知 | 5種類の提出/確認/差戻しテスト |
| 3 | アップロード、プレビュー、version管理 | ファイル検証テスト・v1→v3テスト |
| 4 | コメント、画像ピン、修正依頼 | ピン座標・修正依頼固定記録テスト |
| 5 | 承認、取消、監査、競合防止 | 二重承認/旧版承認防止テスト |
| 6 | 最終納品、ZIP、期限付きダウンロード | ZIP混入なし・期限テスト |
| 7 | テンプレート、検索、ダッシュボード、エクスポート | 各テスト |
| 8 | バックアップ/復元、負荷、セキュリティ | 復元一致テスト・負荷計測 |
| 9 | PWA、E2E、説明書、デプロイ、販売前チェック | E2E 7本、資料一式、RELEASE_CHECKLIST |

進捗は PROGRESS.md、次の作業は NEXT_STEPS.txt を参照。

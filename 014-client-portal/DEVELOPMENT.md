# DEVELOPMENT — 開発・ビルド・デプロイ手順

> 購入者（利用者）が開発環境を用意する必要はありません。購入者向けの手順は `buyer-docs/はじめに.txt`（Fly.io / VPS をコピペで進める手順）を参照。この文書は改修・保守する開発者向けです。

## 構成
```
014-client-portal/
  server/src/          API（Fastify）: app.ts, routes/*, services/*, access.ts(認可), auth.ts, audit.ts, backup.ts, fileTypes.ts, storage/*
  server/migrations/   SQLスキーマ（schemaVersion）
  server/assets/sample サンプル案件用画像
  shared/labels.ts     画面・APIで共通の状態ラベル
  web/                 React SPA（Vite）: pages/op（運営者）, pages/portal（顧客）, components, public（manifest, sw.js, icons）
  scripts/             backup / restore / create-operator / demo / loadtest / gc-orphans / purge-audit / gen-assets / gen-notices
  tests/               API統合テスト（Vitest）
  e2e/                 E2Eテスト（Playwright）
  buyer-docs/          購入者向け資料
```

## 必要なもの
- Node.js 22 以上（file-type 22 が Node 22 以上を要求）
- better-sqlite3 のビルド済みバイナリが取得できない環境では python3 / make / g++

## コマンド
| コマンド | 内容 |
|---|---|
| `npm ci` | 依存インストール |
| `npm run dev:server` / `npm run dev:web` | 開発サーバー（API :8787 / 画面 :5173、/api はプロキシ） |
| `npm run build` | 画面（dist/web）とサーバー（dist/server）をビルド |
| `npm start` | ビルド済みサーバー起動（dist/web も配信） |
| `npm run typecheck` | 型チェック（サーバー・画面） |
| `npm test` | API統合テスト（Vitest） |
| `npm run test:e2e` | E2E（Playwright。事前に `npm run build`） |
| `npm run test:all` | 型チェック→統合→ビルド→E2E |
| `npm run loadtest` | 負荷試験（結果: test-results/loadtest.json） |
| `npm run demo` | デモ環境（./data-demo）を作成して起動 |
| `npm run backup -- <dir>` / `npm run restore -- <dir>` | バックアップ / 復元（OPERATIONS.md） |
| `npm run create-operator -- <email> <氏名> [屋号]` | 運営者追加 |
| `npm run gc-orphans [-- --delete]` | 孤立ファイルの確認・削除 |
| `npm run notices` | THIRD_PARTY_NOTICES.txt 再生成 |
| `node scripts/gen-assets.mjs` | サンプル画像・PWAアイコン再生成（Chromium が必要） |

E2E の Chromium: 既定で `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` を使用。別環境では `CHROMIUM_PATH` を指定するか `npx playwright install chromium`。

## 環境変数
`.env.example` を参照。必須は本番の `SESSION_SECRET`（32文字以上）と `PUBLIC_URL`。`SETUP_TOKEN` を設定すると初回セットアップにトークンが必要（推奨）。

## スキーマ変更
`server/migrations/00N_xxx.sql` を追加し `SCHEMA_VERSION`（server/src/config.ts）を更新。起動時と復元時に自動適用。バックアップは schemaVersion を記録し、新しいスキーマのバックアップは古いアプリへ復元できない。

## デプロイ（本番公開は購入者が自分のアカウントで実施。開発側では実施していない）

### A. Fly.io 東京（推奨）
```
fly launch --no-deploy --copy-config --name <アプリ名> --region nrt
fly volumes create portal_data --region nrt --size 3
fly secrets set SESSION_SECRET=$(openssl rand -hex 32) SETUP_TOKEN=$(openssl rand -hex 12) PUBLIC_URL=https://<アプリ名>.fly.dev
fly deploy
```
- 1台構成（SQLite+Volume）。`fly.toml` は自動停止しない設定。
- Volume スナップショット（既定日次・5日）に加え、OPERATIONS.md のアプリ内バックアップを別の場所へ保存すること。
- 独自ドメイン: `fly certs add portal.example.com` → PUBLIC_URL を変更。
- ファイルを R2 に置く場合: `fly secrets set STORAGE_DRIVER=s3 S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... S3_REGION=auto`（バケットは非公開のまま）。

### B. VPS + Docker Compose
```
git clone <配布物> && cd 014-client-portal
cp .env.example .env   # PUBLIC_URL, SESSION_SECRET, SETUP_TOKEN, DOMAIN を設定
docker compose up -d --build
```
- Caddy が HTTPS 証明書を自動取得（DNS の A レコードを事前に設定）。
- バックアップ: `docker compose exec app node dist/scripts/backup.js /backups`（./backups にホスト側で保存。所有者は UID 1000 の node ユーザーに合わせる: `sudo chown 1000:1000 backups`）。

### 検証状況
- Dockerfile / fly.toml / docker-compose.yml: **この開発環境では Docker デーモン・Fly アカウントがないため実ビルド・実デプロイ未検証**。`NODE_ENV=production` でのビルド成果物起動（SESSION_SECRET 必須・HSTS・セットアップトークン必須・新規登録無効）はローカルで確認済み。

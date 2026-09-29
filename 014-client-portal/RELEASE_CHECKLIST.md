# RELEASE_CHECKLIST — 販売前チェック

凡例: [x] 開発側で確認済み ／ [ ] 未実施（人間の確認が必要）

## A. 機能（完成条件 1〜18）
| # | 完成条件 | 状態 | 根拠 |
|---|---|---|---|
| 1 | PC/iPhone/Androidで運営者/顧客の主要操作 | 実装・エミュレーションで確認済み／**実機未検証** | E2E 10件、TEST_REPORT §4 |
| 2 | PWA構成 | [x] manifest / SW / アイコン / オフライン表示 | E2E PWA・オフライン |
| 3 | 安全な案件招待/失効/再発行 | [x] | auth/authz テスト |
| 4 | 資料リクエスト/提出/確認 | [x] | workflow, E2E-1 |
| 5 | 安全なファイル保存/取得 | [x] | files, s3 テスト |
| 6 | v1/v2/v3履歴 | [x] | workflow |
| 7 | 通常コメント+画像ピン | [x] | workflow, E2E-2 |
| 8 | 修正依頼 | [x] | workflow, E2E-2 |
| 9 | version固定の承認/取消履歴 | [x] | workflow |
| 10 | 新version時の再承認 | [x] | workflow, E2E-4 |
| 11 | 最終納品/一括取得 | [x] | workflow, E2E-3 |
| 12 | 監査履歴 | [x] | backup-audit |
| 13 | アプリ内通知 | [x] | workflow, misc |
| 14 | 案件テンプレート | [x] | workflow |
| 15 | ユーザー/顧客間データ分離 | [x] | authz, E2E-5 |
| 16 | バックアップ/復元 | [x] | backup-audit, s3, E2E-7 |
| 17 | テスト結果を正確に記録 | [x] | TEST_REPORT.md（未検証項目を明記） |
| 18 | 購入者向け資料と運用費資料 | [x] | buyer-docs/, OPERATING_COSTS.md |

## B. 販売前に人間が行う確認（開発環境では実施不可）
- [ ] **実機 iPhone Safari**: 招待→資料提出（写真・HEIC・動画MOV）→制作物確認→ピン→修正依頼→承認→納品ZIP取得（Filesアプリ）
- [ ] **実機 iPhone PWA**: ホーム画面追加→起動→ログイン状態維持→オフライン表示
- [ ] **実機 Android Chrome**: 同上＋「アプリをインストール」
- [ ] iPhone で HEIC を選んだ際に JPEG 変換されるか／HEICのまま保存されるかを確認し「スマホで使う.txt」を更新
- [ ] iPhone での MOV/MP4 再生、PDF の表示（iframe）
- [ ] Docker イメージのビルド（`docker build .`）と docker compose + Caddy での HTTPS 起動
- [ ] Fly.io 東京へのテストデプロイ（有料契約が必要）→ 初期設定 → サンプル作成 → バックアップ取得 → 別アプリへ復元
- [ ] Cloudflare R2 実バケットで STORAGE_DRIVER=s3 の保存・署名URL（期限切れ・改ざん時に拒否されること）・削除
- [ ] SMTP（実サービス）での招待メール・通知メール・マジックリンクの到達と迷惑メール判定
- [ ] OPERATING_COSTS.md の [未検証] 単価（Render / Resend / Backblaze / 国内VPS）を公式サイトで確認・更新
- [ ] 外部の脆弱性診断（任意だが推奨）
- [ ] 販売ページの表記: 「電子契約ではない」「実機確認済み範囲」「負荷試験値は保証値ではない」「サーバー費用は購入者負担」
- [ ] 利用規約・プライバシーポリシーの雛形を同梱するか判断（顧客の個人情報を扱うため）
- [ ] 配布形態（ZIP / GitHub 招待）と、購入者がアップデートを受け取る方法の決定
- [ ] THIRD_PARTY_NOTICES.txt を配布物に同梱

## C. リリース作業
- [x] `npm run test:all` 相当（typecheck / 68 tests / build / 10 E2E）合格（2026-09-29）
- [x] `npm audit --omit=dev` 0件
- [x] `.env.example`、Dockerfile、fly.toml、docker-compose.yml
- [x] 本番モード起動確認（SESSION_SECRET 必須 / HSTS / SETUP_TOKEN / 新規登録無効）
- [ ] 配布用ZIPの作成（node_modules, dist, data*, .tmp, test-results を除外）
- [ ] バージョン番号（server/src/config.ts APP_VERSION, package.json）の確定

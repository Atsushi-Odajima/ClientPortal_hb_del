# Client Portal — 顧客との確認・承認・納品を一か所に

制作案件ごとの顧客専用ページに、資料・制作物・修正指示・承認・納品を集約するセルフホスト型Webアプリです。

> **実装ブランチ：`claude/merge-image-tools`**。この既定ブランチのREADMEは製品の案内です。以下のソース・資料リンクと起動手順は、実装ブランチを参照します。

## できること

- 案件・資料依頼・ファイル受け渡し・版管理・確認承認
- 統合済みの画像ピンによる修正指示と写真セレクト
- 顧客ごとのアクセス制御、監査、バックアップと復元

## 現在の範囲・制限

- スマートフォン実機、実R2 / SMTP、配備先での確認はリリース前の残項目です。
- 統合写真セレクトは元画像を遅延読込し、サムネイル生成は未実装です。複数スタッフ権限・MFA等は拡張候補です。

## 実装の見どころ

**構成：** React / TypeScript / Vite、Node.js、SQLite、ローカル / S3互換ファイル保存。

- [014-client-portal/server/src](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/tree/claude%2Fmerge-image-tools/014-client-portal/server/src)
- [014-client-portal/web/src](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/tree/claude%2Fmerge-image-tools/014-client-portal/web/src)
- [014-client-portal/tests](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/tree/claude%2Fmerge-image-tools/014-client-portal/tests)

## ローカルで試す

Node.js 22以上。demoスクリプトでローカル用サンプルを確認できます。

実装ブランチを取得し、次のディレクトリで作業します。

```sh
git clone --branch claude/merge-image-tools https://github.com/Atsushi-Odajima/ClientPortal_hb_del.git
cd ClientPortal_hb_del/014-client-portal
npm ci
npm run demo
```

環境設定・初期化の詳細：[セットアップ手順](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/blob/claude%2Fmerge-image-tools/014-client-portal/DEVELOPMENT.md)。

## 検証方法

`014-client-portal/` の `package.json` に定義された主な確認コマンドです。DB・ブラウザ・外部ツールを要するものは、開発手順の事前設定が必要です。

```sh
npm run typecheck
npm run test
npm run test:e2e
npm run build
npm run build:web
```

試験の実施環境・結果・未実施項目は、下記の記録を参照してください。画面エミュレーションと実機確認、モックと外部サービスでの確認を区別しています。

## 資料

- [014-client-portal/DEVELOPMENT.md](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/blob/claude%2Fmerge-image-tools/014-client-portal/DEVELOPMENT.md)
- [014-client-portal/NEXT_STEPS.txt](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/blob/claude%2Fmerge-image-tools/014-client-portal/NEXT_STEPS.txt)
- [014-client-portal/README.md](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/blob/claude%2Fmerge-image-tools/014-client-portal/README.md)
- [014-client-portal/TEST_REPORT.md](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/blob/claude%2Fmerge-image-tools/014-client-portal/TEST_REPORT.md)
- [014-client-portal/RELEASE_CHECKLIST.md](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/blob/claude%2Fmerge-image-tools/014-client-portal/RELEASE_CHECKLIST.md)
- [014-client-portal/DATA_MODEL.md](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/blob/claude%2Fmerge-image-tools/014-client-portal/DATA_MODEL.md)
- [014-client-portal/DECISIONS.md](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/blob/claude%2Fmerge-image-tools/014-client-portal/DECISIONS.md)
- [014-client-portal/SECURITY.md](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/blob/claude%2Fmerge-image-tools/014-client-portal/SECURITY.md)
- [014-client-portal/OPERATIONS.md](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/blob/claude%2Fmerge-image-tools/014-client-portal/OPERATIONS.md)
- [画面資料](https://github.com/Atsushi-Odajima/ClientPortal_hb_del/tree/claude%2Fmerge-image-tools/014-client-portal/docs/screenshots)

## 制作・利用条件

制作・管理：**Atsushi Odajima**。実装・資料作成にはAI支援を利用しています。
ソース・同梱ライブラリ・フォント・モデル等の利用条件は、各ライセンスと第三者表記を参照してください。リポジトリの閲覧可能性と、再配布・商用利用の許諾は別です。

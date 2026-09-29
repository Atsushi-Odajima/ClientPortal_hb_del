# Client Portal（商品 #014）

顧客専用ページ・ファイル受け渡し・確認承認。メールやDMに散らばる「資料・修正・承認・納品」を案件専用ページにまとめるセルフホスト型Webアプリ（PWA）。

- 購入者向け: `buyer-docs/はじめに.txt` から
- 開発者向け: `DEVELOPMENT.md`
- 設計: `PLAN.md` / `DECISIONS.md` / `DATA_MODEL.md` / `SECURITY.md` / `FILE_STORAGE.md`
- 運用: `OPERATIONS.md` / `OPERATING_COSTS.md`
- 品質: `TEST_REPORT.md` / `RELEASE_CHECKLIST.md` / `PROGRESS.md` / `NEXT_STEPS.txt`

```
npm ci
npm run build
npm start          # http://localhost:8787
npm run test:all   # 型チェック・統合テスト・ビルド・E2E
```

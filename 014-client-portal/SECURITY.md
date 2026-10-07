# SECURITY — セキュリティ設計と確認結果

最重要要件。実装箇所とテストを対応付けて記録する（結果の数値は TEST_REPORT.md）。

## 1. 認証
| 項目 | 実装 | テスト |
|---|---|---|
| 運営者パスワード | scrypt（N=65536,r=8,p=1、ソルト16B）。10文字以上。存在しないメールでもダミー照合で応答時間を揃える | tests/auth.test.ts |
| セッション | 256bit乱数トークンを HttpOnly / SameSite=Lax / Secure(HTTPS時) Cookie に保存。DBには SHA-256 のみ。運営者14日・顧客30日。ログアウトでDB側も削除、パスワード変更で全セッション破棄 | auth.test.ts（ログアウト後の再利用拒否） |
| 初回セットアップ | 運営者0人のときのみ。SETUP_TOKEN 設定時はトークン必須（公開直後の乗っ取り防止） | auth.test.ts |
| 新規登録 | 本番既定は無効（ALLOW_SIGNUP=false）。追加運営者は CLI `npm run create-operator` | auth.test.ts |

## 2. 顧客アクセス（招待）
- 招待トークン: 256bit乱数、URLフラグメント `/invite#t=` で渡す（サーバーログ・Referer・プロキシに載らない）。画面表示直後に `history.replaceState` でアドレスバーから除去。
- DBは `token_hash` のみ。期限（既定14日/最大90日）・再発行で旧リンク失効・手動失効・アクセス停止（案件単位/顧客単位）・顧客アーカイブで即時無効。
- 引換時に招待先メールアドレスの一致確認。5回失敗でリンクを自動ロック。
- マジックリンク（SMTP設定時のみ）: 15分・1回限り（use_count を条件付きUPDATEで原子的に消費）。応答は登録有無を明かさない。
- テスト: 期限切れ・失効・再発行・ロック・推測トークン・他顧客のメールでの引換（auth.test.ts / authz.test.ts / E2E-5）。

## 3. 認可（サーバー側）
- `/api/app/*` は運営者Cookieのみ、`/api/portal/*` は顧客Cookieのみを参照（Cookie自体を分離）。
- すべての参照で所有者条件を付与（server/src/access.ts）。他者のIDは 404（存在を明かさない）。
- 顧客が読めるファイル: 取り下げられていない資料添付 / 提出済み版 / 公開中かつ期限内の納品に含まれる追加ファイル。作業ファイル（internal）は不可。
- Client Portal 写真セレクト: セットは案件IDで照合（他者・他案件は404）。顧客は準備中（draft）のセット・写真を参照不可、選択に使える写真IDは当該セットのものだけ（他セットのIDは404）。受付終了後の変更は409。顧客は写真を追加できない（ポータルのアップロードは資料リクエストのみ）。「元ファイル名を表示しない」設定ではAPIにもダウンロードのファイル名にも元ファイル名を出さない。
- Client Portal 修正指示: 修正指示書APIは版を案件IDで照合し、修正依頼IDも同じ版・案件で照合。指示タイプの変更は本人のコメントのみ（403）。
- テスト（統合2機能）: tests/merged-tools.test.ts（運営者B・同運営者の別案件の顧客・別運営者の顧客からの参照/操作が404、Cookie取り違えが401 など）。
- アップロードIDも作成者本人のみ操作可、各チャンクで案件アクセス権を再確認（途中でアクセス停止された場合も拒否）。
- テスト: 運営者A→B（参照12種・更新12種・一覧/検索/監査）、顧客B→A（参照10種・更新6種）、顧客→管理API、運営者Cookie→顧客API、内部ファイル、未認証（authz.test.ts 11件、E2E-5）。

## 4. CSRF / XSS / ヘッダ
- 状態変更リクエストは `X-CP-CSRF: 1` ヘッダ必須（クロスサイトのフォーム送信では付与不可、CORSは許可していない）＋ Origin 検証。
- React の自動エスケープのみ使用（`dangerouslySetInnerHTML` 不使用）。
- CSP: `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'`。
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy`, `COOP`, HTTPS時 HSTS。
- 外部リンク（顧客が入力したURL）は http/https のみ受理し `rel="noreferrer noopener"`。

## 5. ファイル
- 拡張子ブロックリスト（実行形式・スクリプト・HTML等）、マジックバイト判定で実行形式（MZ/ELF/Mach-O/shebang等）を拒否、既知拡張子と実体の不一致を拒否、0バイト拒否、サイズ上限（開始時・チャンク受信中に超過で打ち切り）。
- 配信: Content-Type はサーバー判定値、プレビュー可能形式（JPEG/PNG/GIF/WebP/PDF/MP4/WebM/MOV）以外は `application/octet-stream` + `attachment`。画像/動画プレビューにも `Content-Security-Policy: sandbox`。SVG/HTML/テキストは同一オリジンで描画しない。
- Content-Disposition は RFC 5987（制御文字・引用符を除去、ヘッダインジェクション不可）。
- ストレージキーはIDのみ（ユーザー入力パスを使わない）＋ パストラバーサル検証。
- テスト: files.test.ts（16件）。

## 6. 承認の整合性
- 最新版のみ・サーバーで直前再確認・expectedVersionNumber 照合・冪等キー・有効承認は1版1件（部分UNIQUE）・承認/修正依頼/版ファイル/監査ログはDBトリガーで改変不可。

## 7. レート制限
- 全体 600回/分/IP、ログイン 10回/分、招待確認 20回/分、マジックリンク 5回/15分、新規登録 5回/10分、コメント 60回/分、承認 30回/分、ZIP 20回/分、エクスポート 3回/10分。
- 単一プロセス内メモリ方式（1インスタンス運用前提）。本番（NODE_ENV=production）では無効化できない。

## 8. ログ・秘密情報
- リクエストログは method / URL（token等のクエリをマスク）/ IP のみ。Cookie・Authorization・Set-Cookie は redact。
- 監査ログ detail から token/password/secret/cookie キーを除外。IPは HMAC で匿名化（ip_hash）。
- 秘密情報は環境変数（SESSION_SECRET, SETUP_TOKEN, S3キー, SMTP_URL）。`.env` は gitignore。本番で SESSION_SECRET 未設定なら起動しない。
- メールは送信後に本文を消去（マジックリンクを残さない）。ファイルは添付しない。
- テスト: backup-audit.test.ts（ログにトークン・パスワード・Cookieが出ないこと、監査ログ/招待テーブルに生トークンがないこと）。

## 9. 削除・アーカイブ後のアクセス仕様
| 状態 | 顧客アクセス |
|---|---|
| ポータル非公開/終了 | 案件の全API 404 |
| 案件アーカイブ | 404 |
| 案件削除 | DB・ファイル実体削除、404 |
| 顧客アーカイブ | 全セッション破棄、401 |
| アクセス停止 | 該当案件 404、招待失効 |
| 納品の期限切れ | 納品タブ/ZIP 410（制作物確認画面の版ファイルはポータル公開中は閲覧可） |
| 納品取り下げ | 404 |

## 10. 既知の制限・残リスク
- 招待リンクとメールアドレスの両方を第三者が入手した場合はアクセスされうる（期限・失効・利用履歴で運用対応）。
- 顧客セッションは端末に30日残る。共用PCではログアウトを案内（顧客向け案内に記載）。
- ウイルススキャンは未実装（ClamAV等の連携は将来候補）。ZIP内部の検査はしない。
- レート制限はプロセス内メモリのため再起動でリセット、複数インスタンスでは共有されない。
- PDFはブラウザ内蔵ビューアで表示するため、PDF内スクリプトの扱いはブラウザ依存（CSPで外部通信は遮断）。
- 2要素認証は未実装（将来候補）。
- 外部の脆弱性診断・ペネトレーションテストは未実施（販売前の人間確認事項）。

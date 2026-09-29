# FILE_STORAGE — ファイル保存・配信の設計

## ドライバ
| STORAGE_DRIVER | 保存先 | 用途 |
|---|---|---|
| `local`（既定） | `DATA_DIR/objects/p/<projectId>/<fileId>` | 小〜中規模（〜数十GB）。VPS / Fly Volume |
| `s3` | S3互換バケット（Cloudflare R2 / AWS S3 / Backblaze B2 など）。**非公開バケット**で運用 | 大容量・転送量が多い場合 |

S3設定: `S3_ENDPOINT`, `S3_REGION`（R2は `auto`）, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`。
S3ドライバはローカルのS3互換エミュレータ（s3rver）で自動テスト済み。**実際の R2 / S3 への接続は未検証**（契約・秘密情報が必要なため実施していない）。

## ストレージキー
`p/<projectId>/<fileId>`（サーバー生成IDのみ、英数字と `_`）。元ファイル名・ユーザー入力は含めない。`assertSafeKey` と実パスの接頭辞チェックでトラバーサルを防止。

## アップロード（分割）
1. `POST .../uploads` { name, size, target } → 事前チェック（名前長・0バイト・上限・拡張子ブロック・容量上限・提出先の受付可否）→ `uploadId, chunkSize(既定8MB), chunkCount`
2. `PUT /api/uploads/:id/chunks/:n`（application/octet-stream）: チャンクごとに一時ファイルへ。宣言サイズ超過は受信中に打ち切り。再送は上書き（冪等）。ブラウザ側は最大4回の自動再試行（指数バックオフ）。
3. `GET /api/uploads/:id` で受信済みチャンクを確認し、途中から再開可能（「再試行」ボタン）。
4. `POST /api/uploads/:id/complete`: 状態を `completing` にロック → 結合しながら SHA-256 → サイズ照合 → 実体検査（file-type）→ 提出先を再検証 → **ストレージ保存** → **DBトランザクション**（files 行＋版作成/添付/納品項目＋監査ログ）。
   - ストレージ保存失敗: DBに何も残さない。状態を `uploading` に戻し、チャンクを保持して再試行可能。
   - DB失敗: 保存した実体を削除。
   - 完了済みへの再送: 同じ結果を返す（通信断後の二重提出防止）。
5. 一時ファイルは完了時に削除。未完了は24時間で期限切れ → 定期ジョブで掃除。

大容量について: 現在はアプリサーバー経由（検証・ハッシュを確実にするため）。既定上限 500MB/ファイル。GB級の動画が中心の場合は、R2 への署名付き直接マルチパートアップロード（サーバー側で後から検証）への拡張を NEXT_STEPS に記載。

## 種類の判定（server/src/fileTypes.ts）
- 拒否: 実行形式・スクリプト・HTML等の拡張子（exe, bat, js, html, ps1, apk, dmg など）、実体が実行形式（MZ/ELF/Mach-O/shebang/Java class/wasm 等）
- 既知拡張子（jpg/png/gif/webp/heic/pdf/mp4/mov/docx/zip 等）は実体の判定結果と一致しなければ拒否
- テキスト系（txt/csv/md/json/svg/xml）は実体判定なしを許容。ただしプレビューせずダウンロードのみ
- 未知の拡張子（.ai/.fig/.psd 以外の独自形式など）は実行形式でなければ `application/octet-stream` として保存・ダウンロードのみ

## プレビュー・配信
| 形式 | 表示 | ヘッダ |
|---|---|---|
| JPEG/PNG/GIF/WebP | インライン（ピンコメント可） | Content-Type=判定値, `inline`, CSP `sandbox` |
| PDF | iframe でブラウザ内表示 | CSP（外部通信なし）。iPhone では表示が限定的なためダウンロードも案内 |
| MP4/WebM/MOV | `<video playsinline>`（Range対応） | CSP `sandbox` |
| HEIC/TIFF/PSD/AI/SVG/その他 | プレビューなし・ダウンロード | `application/octet-stream`, `attachment`, CSP `sandbox` |

共通: `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, max-age=300`, ETag。
ダウンロード（`?dl=1`）: s3ドライバでは **期限付き署名URL（既定300秒, SIGNED_URL_SECONDS）** へ302リダイレクト（Content-Disposition/Type も署名に含める）。local ではアプリが認可済みリクエストにのみストリーム返却。
プレビューは s3 でもアプリ経由（CSP の img-src を 'self' に保つため）。

**ファイルURLを知るだけではアクセス不可**: すべての取得APIはセッションCookie＋案件権限＋ファイル用途チェックを通る。署名URLは5分で失効。

## 未検証の形式（実機確認が必要）
- iPhone の HEIC 写真: アップロード・保存・ダウンロードはサーバーテスト済み（file-type で heic 判定）。**実機 iPhone からの選択時に Safari が JPEG に変換するかは未確認**。プレビューは行わない。
- iPhone の MOV 動画: MOV は保存・Range配信可能。**実機での再生は未確認**（コーデックに依存）。
- Android の動画・写真: 実機未確認。

## ZIP 一括ダウンロード
- 納品セットに含まれるファイルのみを、案件IDを再照合したうえで store（無圧縮）でストリーミング生成（一時ファイルなし）。
- エントリ名は `<納品タイトル>/<制作物名>_v<番号>.<拡張子>`、追加ファイルは元ファイル名。すべて安全化（`/ \ : * ? " < > |`・制御文字・先頭ドット除去、200byte上限、重複は ` (2)`）。
- 合計が `MAX_ZIP_MB` 超過なら 413 とし個別ダウンロードを案内。失敗時は再度押せば最初から再生成（再試行）。非同期生成は未実装（上限で運用）。

## 削除
- 案件削除: DB削除をコミット後に実体削除（失敗分は孤立ファイルとして残る → OPERATIONS.md の掃除手順）。
- 取り下げ（withdrawn）: 実体は残し非表示（履歴保持）。案件削除時に消える。

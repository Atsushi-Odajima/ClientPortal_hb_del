# DECISIONS — 設計判断の記録

各判断は「採用 / 理由 / 代替案 / 見直し条件」。料金は OPERATING_COSTS.md（2026-09-29 調査）参照。

## D1. 提供形態: セルフホスト型（購入者が自分の環境へデプロイ）
- 採用: 購入者1人（または小規模事業者）が1インスタンスを運用。1インスタンス内で複数の運営者アカウントを持てる（データは運営者ごとに完全分離）。
- 理由: 買い切り価格（9,800〜14,800円）で継続的なSaaS運営費を販売者が負担しない。ファイル保管責任を購入者側に置ける。
- 代替: 販売者運営のマルチテナントSaaS → 月額課金・運用体制が必要なため初版では不採用。
- 利用者へ開発環境を要求しない: Dockerイメージ / Fly.io / VPS 手順を「コピペで実行」レベルで提供（DEVELOPMENT.md・はじめに.txt）。

## D2. 技術構成
| 層 | 採用 | 理由 |
|---|---|---|
| ランタイム | Node.js 22 LTS | 長期サポート、file-type 最新版が Node 22 以上を要求 |
| API | Fastify 5 + zod 4 | 高速・スキーマ検証・レート制限/クッキー公式プラグイン |
| DB | SQLite（better-sqlite3, WAL） | 1インスタンス運用に最適、バックアップが単純（オンラインバックアップAPI）、外部DB費用ゼロ |
| フロント | React 19 + TypeScript + Vite + react-router 7 | 安定・PWA構成が容易 |
| PWA | 手書き Service Worker + manifest | 依存を増やさず、API/ファイルを一切キャッシュしない制御を明確化 |
| ストレージ | ドライバ方式（local / S3互換） | 小規模はディスクのみ、容量増は R2 等へ切替 |
| テスト | Vitest（API統合）+ Playwright（E2E, モバイルエミュレーション） | |
- 見直し条件: 同時利用者が多い・複数インスタンス化が必要 → PostgreSQL へ移行（DATA_MODEL はSQL標準寄りに設計）。

## D3. 顧客アクセス方式: 期限付き招待リンク + 登録メール照合 + 端末セッション（+ 任意のマジックリンク再ログイン）
比較:
| 方式 | 安全性 | UX | 備考 |
|---|---|---|---|
| 推測可能な永久公開URL | ✕ | ◎ | 禁止要件 |
| メール招待 + マジックリンク毎回 | ○ | △ | 毎回メール受信が必要・メール基盤必須 |
| 顧客アカウント（パスワード） | ○ | ✕ | 顧客に登録負担。小規模案件では離脱が多い |
| **期限付き招待リンク + メール照合 + セッション**（採用） | ○ | ◎ | メール基盤なしでも運用可（LINE/メールで運営者がリンク送付） |
- トークン: 256bit乱数（base64url 43文字）。DBには SHA-256 ハッシュのみ保存。URLは `/invite#t=<token>`（フラグメントなのでサーバーログ・Refererに載らない）。
- 期限: 既定14日（1〜90日）、再発行で旧リンク自動失効、手動失効、アクセス停止（案件単位 / 顧客単位）。
- 開いた人に招待先メールアドレスの入力を求め、5回失敗でリンクをロック（リンク単体の漏えい対策）。
- 引換後は HttpOnly Cookie の端末セッション（既定30日）。PC とスマホの両方で同じリンクを期限内に使える。
- メール送信（SMTP）を設定した場合のみ、顧客自身が「ログイン用リンク」を請求可能（15分・1回限り）。
- 限界: メールアドレスを知る第三者がリンクも入手した場合は防げない → 期限・失効・アクセス履歴で運用（SECURITY.md）。

## D4. 認可モデル
- 運営者Cookie（cp_op）と顧客Cookie（cp_cl）を分離。/api/app/* は運営者Cookieのみ、/api/portal/* は顧客Cookieのみを参照。顧客は管理APIに到達できない。
- 全クエリで所有者条件（owner_id / 有効な portal_access）を付与する共通関数（server/src/access.ts）を必ず通す。他者IDは存在を明かさないため 404。
- ファイル取得は「案件への権限」+「ファイル用途ごとの公開可否」の二段階（内部ファイル・未公開納品・期限切れ納品は不可）。

## D5. ファイル保存方式
- 分割アップロード（既定8MBチャンク）→ サーバーで結合しながら SHA-256 → 実体検査（file-type によるマジックバイト判定＋拡張子ポリシー）→ ストレージ保存 → DB記録（トランザクション）。DB失敗時は実体を削除、保存失敗時はDBに何も残さない。
- ストレージキーは `p/<projectId>/<fileId>` のみ（ユーザー入力を含めない）。
- ダウンロード: local はアプリ経由（認可済みリクエストのみ、Range対応）。s3 はダウンロード時のみ期限付き署名URL（既定300秒）へリダイレクト、プレビューはアプリ経由（CSP を 'self' に保つため）。
- 見直し: 大容量が多い場合は R2 への直接マルチパートアップロード（署名付きPUT）へ拡張（NEXT_STEPS）。

## D6. version / 承認モデル
- 制作物（deliverables）= versionGroup。版（deliverable_versions）は1版1ファイル、番号は連番、提出後のファイル差替えはDBトリガーで禁止。新版提出時に旧版は `superseded`（削除・上書きしない）。
- 承認は「最新版」かつ「確認待ち/修正依頼」状態のみ。承認直前にサーバーで最新版を再確認し、クライアントが見ていた版番号（expectedVersionNumber）も照合。
- 二重承認防止: 冪等キー（UNIQUE）+ 「有効な承認は1版1件」部分UNIQUEインデックス。
- 承認記録は不変（トリガー）。取消は revoked_* を追記するだけ（削除しない）。新版に旧承認は引継がない。
- 電子契約・法的署名ではない旨を画面と説明書に明記。

## D7. PWA方針
- アプリシェル（HTML/JS/CSS/アイコン）のみキャッシュ。/api/* とファイルは一切キャッシュしない（認可・失効を確実に反映）。
- オフライン時は送信系ボタンを無効化し「オフラインのため送信できません」と表示。コメントは端末内に「未送信の下書き」として保持（自動送信しない）。
- 再接続時は画面を再取得し、承認はサーバーで最新版確認（古い版への承認を防ぐ）。

## D8. 通知
- アプリ内通知（必須）: 資料提出/差戻し/確認、制作物提出、コメント、修正依頼、承認/取消、納品公開、期限超過（1日1回・重複防止キー）。
- メール（任意, MAIL_DRIVER=smtp）: outbox 方式・重複防止キー・最大5回再試行・送信後本文消去・添付なし（ポータルへ誘導）。受信者ごとにON/OFF。
- Push通知: 初版対象外。

## D9. デプロイ先の推奨
- 推奨A: Fly.io 東京リージョン（nrt）+ Volume（SQLite・ファイル）+ 任意で Cloudflare R2（ファイル）。東京リージョンが公式に確認できたため。
- 推奨B: 国内VPS + Docker（Compose）。転送量無制限プランが多い（料金は未検証、OPERATING_COSTS 参照）。
- Render: 日本リージョンなし・ディスク付きサービスは1インスタンス制約（未検証情報あり）→ 代替として手順のみ記載。
- 本番公開・有料契約は購入者が行う（開発側では実施していない）。

## D10. サンプルデータ
- 本番DBと分離するため、①アプリ内「サンプル案件を作成」（is_sample=1、ワンクリック削除、メール送信なし）②`DATA_DIR` を分けたデモ起動（npm run demo）の2通り。

## D11. 監査ログ
- 追記専用テーブル + UPDATE/DELETE 禁止トリガー + SHA-256 ハッシュチェーン（改ざん検出）。
- 秘密情報キー（token/password/secret/cookie）は detail から除外。ファイル本文・コメント本文は保存しない（要約のみ）。
- 案件削除時も監査ログは残す（IDとイベント種別のみ）。完全消去が必要な場合の保守手順は OPERATIONS.md。

## D12. 単体ツール2本の統合（2026-10-07）: Client Portal 修正指示 / Client Portal 写真セレクト
統合元（読み取り専用・変更していない）: hanbai4 `image-correction-maker`（画像 修正指示メーカー）、hanbai9 `009-photo-select-list-maker`（写真セレクト一覧メーカー）。
命名規則: 製品名のない統合機能は本アプリ名を冠する（画面・資料で「Client Portal 修正指示」「Client Portal 写真セレクト」）。

### D12-1. Client Portal 修正指示 = 既存の画像ピンコメントを拡張（新しい注釈テーブルは作らない）
- 採用: 既存の制作物版のピンコメント（comments.pin_*）に `pin_type`（change/delete/add/move/keep/other、元ツールの6種）を追加。修正指示書（番号入り画像＋【修正指示】【変更しない箇所】の一覧）を運営者・顧客の両方で表示・印刷・テキスト保存（BOM+CRLF）・番号入り画像保存（ブラウザのCanvasで元画像実寸に描画、JPEGはJPEG/他はPNG）。
- 理由: 本アプリには既に「画像に相対座標でピン → コメント → 修正依頼に固定記録（pin_comment_ids_json）」の流れがあり、別系統の注釈を作ると二重管理になる。修正依頼（change_requests）が依頼時点の未解決ピンIDを保持しているため、「この修正依頼の修正指示書」をそのまま再現できる（承認・修正依頼フローとの自然な連携）。
- 番号: 元ツールは削除時に振り直すが、本アプリはピン作成時に確定した pin_number を使い**振り直さない**（顧客と運営者がチャット等で番号を共有した後にずれないため。修正依頼の固定記録とも一致）。丸数字 ①〜⑳・21以降 (21)・テキスト構成・定型文の連結規則・マーカー描画（赤丸/青角丸、白縁+暗い外縁+影、短辺×5%）は元ツールから移植（shared/correctionSheet.ts, web/src/components/CorrectionSheet.tsx）。
- 対象: 制作物の版（画像: JPEG/PNG/GIF/WebP）のみ。資料添付の画像への注釈は対象外（修正の対象は制作物であり、承認フローと結び付かないため）。
- 統合しなかったもの: ZIP一括保存（印刷/PDF・画像・テキストを個別に保存できるため不要。自作ZIPは移植しない）、マーカーのドラッグ移動・矢印キー移動・Undo・マーカーサイズ切替（ピンは送信済みコメントであり、位置変更は「削除して置き直す」運用）、クリップボードからの画像貼り付け（画像は版として提出する流れ）、案件名等の入力欄（案件・制作物から自動）。

### D12-2. Client Portal 写真セレクト = 新テーブル4つ + files.purpose 'selection_photo'
- 採用: 運営者が写真をまとめてアップロード（既存の分割アップロード、target.purpose='selection_photo'）→ 001〜の番号付き「セレクト」→ 顧客がポータルでタップまたは番号入力で選択（その都度サーバー保存）→ 送信で運営者に通知 → 運営者は番号→元ファイル名で確認・CSV/テキスト書き出し。
- 番号: `selection_photos.position`（1始まり）。準備中（draft）のみ並べ替え・削除可（削除・並べ替え後は欠番なく詰め直す）。公開（open）後は番号を固定し、追加は末尾。元ツールの「渡した後に並べ替えると番号が変わる」問題をサーバー側で防ぐ。
- 移植した規則（shared/photoSelect.ts、元テストも移植）: 3桁ゼロ埋め（999超は桁を伸ばす）、自然順（localeCompare ja numeric）、区切り（, ， 、 ､ 空白 全角空白 タブ 改行）、全角数字、0省略（7→007、入力表記を表示）、該当なしは補正しない、数字以外は「読み取れなかった文字」、重複通知、CSV（BOM・CRLF・引用・数式インジェクション対策）、上限300枚/警告150枚。
- files の CHECK 制約変更のため migration 002 で files を作り直す（SQLite 推奨手順。`-- migrate:foreign-keys-off` 指定のマイグレーションは外部キーを一時無効化し、コミット前に foreign_key_check。server/src/db.ts）。
- 画像のみ受付（file-type 判定で preview_kind='image'）。同一セットに同じ内容（SHA-256一致）は二重登録不可（元ツールの「同じファイルは追加しない」）。同名の別写真は登録し「同名あり」表示。
- 「元ファイル名を表示」設定（show_names）: OFF なら顧客APIは名前を返さず、ファイル配信の Content-Disposition も「007.jpg」にする。
- 統合しなかったもの: 共有用HTML一覧ZIP・A4印刷レイアウト（ポータル自体が共有ページのため）、サムネイル生成（サーバーに画像処理ライブラリを追加しない方針。`loading="lazy"` で元画像を表示。大量・大容量写真では重くなる → NEXT_STEPS）、3列/4列切替（画面幅で自動）。

### D12-3. FreelanceDesk への統合（candidate 7）向け引き継ぎ
- 新テーブル: `selection_sets`, `selection_photos`, `selection_picks`, `selection_responses`。既存変更: `comments.pin_type` 追加、`files.purpose` に `selection_photo` 追加（files 作り直し）。SCHEMA_VERSION=2。詳細は DATA_MODEL.md。
- 新API（運営者 `/api/app/projects/:id/…`、顧客 `/api/portal/projects/:id/…`）:
  - 修正指示: `GET …/versions/:vid/instructions?format=json|txt&changeRequestId=&includeResolved=1`（両側）。コメント作成/編集に `pinType`（任意）。versionDto.changeRequests に `pinCount`。
  - 写真セレクト（運営者）: `GET/POST …/selections`, `GET/PATCH/DELETE …/selections/:sid`, `POST …/:sid/status {status:open|closed}`, `POST …/:sid/photos/:phid/move {toNumber}`, `POST …/:sid/sort-by-name`, `POST …/:sid/photos/delete {photoIds}`, `GET …/:sid/export?kind=map|picks&format=csv|txt&clientId=`。写真追加は `POST /api/app/projects/:id/uploads` に `target:{purpose:'selection_photo', setId}`。
  - 写真セレクト（顧客）: `GET …/selections`, `GET …/selections/:sid`, `POST …/:sid/picks {photoIds}|{numbersText, mode:add|replace}`, `POST …/:sid/submit {note}`。
- 新画面: 運営者 `/app/projects/:pid?tab=selections`（一覧・作成）、`/app/projects/:pid/selections/:sid`（SelectionOp）、`/app/projects/:pid/deliverables/:did/sheet/:vid[?cr=]`（修正指示書）。顧客 `/portal/p/:pid/select`, `/portal/p/:pid/select/:sid`, `/portal/p/:pid/review/:did/sheet/:vid[?cr=]`。ホーム「やること」に未送信セレクト（clientTodo.selections）。
- 通知種別: `selection_opened`（顧客へ）、`selection_submitted`（運営者へ）。監査: `selection.created/opened/reopened/closed/photos_deleted/deleted/submitted`。
- 認可は既存の access.ts（ownedProject / clientProject）を必ず通し、セットは project_id で照合（他者は404）。顧客は draft を参照不可、写真ファイルは assertClientCanReadFile の `selection_photo` 分岐（公開済みセットのみ）。
- 共有ロジックは DOM 非依存の `shared/photoSelect.ts`, `shared/correctionSheet.ts`（そのまま移植可能）。

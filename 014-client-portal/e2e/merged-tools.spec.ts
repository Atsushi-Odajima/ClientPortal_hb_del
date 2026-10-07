import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ANDROID, ROOT, SAMPLE, addDeliverableUI, apiCall, createProjectUI, issueInviteUI, openInvite, signupOperator, uniq } from './helpers';

// SHOTS=1 のときだけ docs/screenshots に画面キャプチャを保存する
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: path.join(ROOT, 'docs/screenshots', name), fullPage: true });
};

// 統合した2機能の E2E:
//  E2E-8 Client Portal 修正指示（指示タイプ付きピン → 修正依頼 → 修正指示書の表示・テキスト/番号入り画像の保存）
//  E2E-9 Client Portal 写真セレクト（運営者が写真を登録・公開 → 顧客がタップ＋番号入力で選択・送信 → 運営者が結果確認・CSV）

test('E2E-8: 顧客が指示タイプ付きピン（変更しない/削除）→修正依頼→修正指示書（運営者・顧客）', async ({ browser }) => {
  const { page: op } = await signupOperator(browser);
  const email = `${uniq('c')}@example.com`;
  const pid = await createProjectUI(op, email, '修正指示案件');
  const url = await issueInviteUI(op, pid);
  const did = await addDeliverableUI(op, pid, 'バナー', SAMPLE('post-a-v1.png'));

  const { page: cl } = await openInvite(browser, url, email);
  await cl.getByTestId('todo-review').click();
  const img = cl.getByTestId('pin-image').locator('img');
  await expect(img).toBeVisible();
  // ① 変更しない（青い四角）
  await cl.getByTestId('pin-mode').click();
  let box = (await img.boundingBox())!;
  await cl.getByTestId('pin-image').click({ position: { x: box.width * 0.2, y: box.height * 0.2 } });
  await cl.getByTestId('pintype-keep').click();
  await cl.getByTestId('comment-input').fill('ロゴはそのままで');
  await cl.getByRole('button', { name: 'コメントを送信' }).click();
  await expect(cl.getByText('ロゴはそのままで')).toBeVisible();
  // ② 定型文「削除してください」→ 指示タイプも「削除」
  await cl.getByTestId('pin-mode').click();
  box = (await img.boundingBox())!;
  await cl.getByTestId('pin-image').click({ position: { x: box.width * 0.75, y: box.height * 0.8 } });
  await cl.getByTestId('comment-input').fill('右下の注意書きを');
  await cl.getByRole('button', { name: '削除してください' }).click();
  await expect(cl.getByTestId('pintype-delete')).toHaveAttribute('aria-checked', 'true');
  await expect(cl.getByTestId('comment-input')).toHaveValue('右下の注意書きを削除してください。');
  await cl.getByRole('button', { name: 'コメントを送信' }).click();
  await expect(cl.getByText('右下の注意書きを削除してください。')).toBeVisible();
  await expect(cl.getByTestId('pin-1')).toHaveClass(/keep/);
  await expect(cl.getByTestId('pin-2')).not.toHaveClass(/keep/);

  // 修正依頼 → この依頼の修正指示書
  await cl.getByTestId('change-open').click();
  await expect(cl.getByText('修正指示書」として一緒に担当者へ伝わります', { exact: false })).toBeVisible();
  await cl.getByTestId('change-body').fill('ピンの通りお願いします');
  await cl.getByRole('button', { name: '修正を依頼する' }).click();
  await cl.getByRole('link', { name: /この依頼の修正指示書（ピン2件）/ }).click();
  await expect(cl.getByTestId('correction-sheet')).toBeVisible();
  await expect(cl.getByTestId('sheet-fix').locator('li')).toHaveCount(1);
  await expect(cl.getByTestId('sheet-keep').locator('li')).toHaveCount(1);
  await expect(cl.getByTestId('sheet-text')).toHaveValue(/【修正指示】[\s\S]*② \[削除\][\s\S]*【変更しない箇所】[\s\S]*①\nロゴはそのままで/);
  await expect(cl.getByTestId('sheet-image').locator('.mk.keep')).toHaveCount(1);
  await shot(cl, 'ip-correction-sheet.png');

  // 運営者PC: 確認画面から修正指示書 → テキスト・番号入り画像を保存
  await op.goto(`/app/projects/${pid}/deliverables/${did}`);
  await expect(op.getByTestId('pin-type').first()).toBeVisible();
  await op.getByTestId('sheet-open').click();
  await expect(op.getByTestId('correction-sheet')).toBeVisible();
  await expect(op.getByTestId('sheet-image').locator('img')).toHaveJSProperty('complete', true);
  await shot(op, 'pc-correction-sheet.png');
  const [txt] = await Promise.all([op.waitForEvent('download'), op.getByTestId('sheet-save-text').click()]);
  const txtBuf = fs.readFileSync((await txt.path())!);
  expect(txtBuf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  expect(txtBuf.toString('utf8')).toContain('【変更しない箇所】\r\n\r\n①\r\nロゴはそのままで');
  const [pngDl] = await Promise.all([op.waitForEvent('download'), op.getByTestId('sheet-save-image').click()]);
  // Linux コンテナ（ロケール C）の Chromium は Blob ダウンロードの日本語名を "download" に置き換えるため両方を許容（元ツールの開発メモと同じ事情）
  expect(pngDl.suggestedFilename()).toMatch(/^(修正指示_バナー_v1\.png|download)$/);
  const out = fs.readFileSync((await pngDl.path())!);
  const orig = fs.readFileSync(SAMPLE('post-a-v1.png'));
  expect(out.subarray(1, 4).toString('ascii')).toBe('PNG');
  // 元画像と同じ実寸で書き出し、内容は元画像と異なる（番号が描かれている）。元ファイルは変更しない
  expect(out.readUInt32BE(16)).toBe(orig.readUInt32BE(16));
  expect(out.readUInt32BE(20)).toBe(orig.readUInt32BE(20));
  expect(out.equals(orig)).toBe(false);
  const apiFile = await apiCall(op, 'GET', `/api/app/projects/${pid}/versions/${(await apiCall(op, 'GET', `/api/app/projects/${pid}/deliverables/${did}`)).body.deliverable.versions[0].id}/instructions`);
  expect(apiFile.body.pins.map((p: { type: string }) => p.type)).toEqual(['keep', 'delete']);
});

test('E2E-9: 写真セレクト（運営者が登録・公開→顧客がタップと番号で選択・送信→運営者が元ファイル名で確認・CSV）', async ({ browser }) => {
  const { page: op } = await signupOperator(browser);
  const email = `${uniq('c')}@example.com`;
  const pid = await createProjectUI(op, email, '撮影案件');
  const url = await issueInviteUI(op, pid);

  // 元ファイル名の自然順（IMG_1 → IMG_2 → IMG_10）で番号が付くことを確認するため、逆順の名前で用意
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-photos-'));
  const files = [
    ['IMG_10.png', 'post-a-v1.png'],
    ['IMG_2.png', 'post-a-v2.png'],
    ['IMG_1.png', 'post-b-v1.png'],
  ].map(([name, src]) => {
    const p = path.join(dir, name);
    fs.copyFileSync(SAMPLE(src), p);
    return p;
  });

  await op.goto(`/app/projects/${pid}?tab=selections`);
  await op.getByTestId('selection-title').fill('9/28 撮影分');
  await op.getByRole('button', { name: '作成して写真を追加' }).click();
  await op.waitForURL(/\/selections\/sel_/);
  await op.getByTestId('file-input').setInputFiles(files);
  await expect(op.getByTestId('op-photo-003')).toBeVisible({ timeout: 20_000 });
  await expect(op.getByTestId('op-photo-001')).toContainText('IMG_1.png');
  await expect(op.getByTestId('op-photo-002')).toContainText('IMG_2.png');
  await expect(op.getByTestId('op-photo-003')).toContainText('IMG_10.png');
  await op.getByRole('button', { name: 'お客様に公開（選択受付を開始）' }).click();
  await expect(op.getByTestId('selection-status')).toHaveText('選択受付中');

  // 顧客（Android）: やること → タップで1枚、番号入力で1枚
  const { page: cl } = await openInvite(browser, url, email, ANDROID);
  await cl.getByTestId('todo-selection').click();
  await expect(cl.getByTestId('photo-001')).toBeVisible();
  await expect(cl.getByTestId('photo-001').locator('img')).toHaveJSProperty('complete', true);
  await cl.getByTestId('photo-001').getByRole('button', { name: '選ぶ' }).click();
  await expect(cl.getByTestId('picked-numbers')).toHaveText('001');
  await cl.getByTestId('numbers-input').fill('3、9 abc');
  await cl.getByRole('button', { name: '選択に追加' }).click();
  await expect(cl.getByTestId('check-result')).toContainText('003 → IMG_10.png');
  await expect(cl.getByTestId('check-result')).toContainText('009 → 該当なし');
  await expect(cl.getByTestId('check-result')).toContainText('読み取れなかった文字: abc');
  await expect(cl.getByTestId('picked-numbers')).toHaveText('001, 003');
  await cl.getByRole('button', { name: 'この内容で送信する' }).click();
  await expect(cl.getByText('2枚の選択を送信しました')).toBeVisible();
  await expect(cl.getByTestId('select-summary')).toContainText('送信済み');
  await shot(cl, 'ip-photo-select.png');

  // 運営者: 番号 → 元ファイル名で確認、CSV
  await op.reload();
  const resp = op.getByTestId('selection-response');
  await expect(resp).toContainText('見本 花子（2枚）');
  await expect(resp.getByTestId('response-picks')).toHaveText(/001 → IMG_1\.png\s*003 → IMG_10\.png/);
  await op.getByTestId('op-reply-input').fill('002');
  await expect(op.getByTestId('check-result')).toContainText('002 → IMG_2.png');
  await shot(op, 'pc-photo-select.png');
  const href = await op.getByTestId('export-picks-csv').getAttribute('href');
  const csv = await apiCall(op, 'GET', href!);
  expect(csv.status).toBe(200);
  expect(Buffer.from(csv.body as Buffer).toString('utf8')).toBe('﻿番号,元ファイル名\r\n001,IMG_1.png\r\n003,IMG_10.png\r\n');
  // 運営者に通知が届いている
  const n = await apiCall(op, 'GET', '/api/app/notifications');
  expect(n.body.notifications.some((x: { kind: string }) => x.kind === 'selection_submitted')).toBe(true);
});

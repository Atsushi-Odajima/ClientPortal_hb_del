import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import {
  ANDROID,
  IPHONE,
  PASSWORD,
  ROOT,
  SAMPLE,
  addDeliverableUI,
  apiCall,
  approveUI,
  createProjectUI,
  issueInviteUI,
  openInvite,
  signupOperator,
  submitNewVersionUI,
  uniq,
} from './helpers';

test('E2E-1: 顧客/案件作成→招待→顧客アクセス→資料3件提出→運営者確認→制作開始', async ({ browser }) => {
  const { page: op } = await signupOperator(browser);
  const clientEmail = `${uniq('c')}@example.com`;
  const pid = await createProjectUI(op, clientEmail, '秋キャンペーンSNS素材制作');

  // 資料リクエスト3件（ファイル・テキスト・URL）
  await op.getByRole('tab', { name: /資料/ }).click();
  for (const [title, kind] of [
    ['ロゴ', 'ファイル'],
    ['掲載文', 'テキスト'],
    ['参考URL', 'URL'],
  ]) {
    await op.getByRole('button', { name: '＋ 資料リクエスト' }).click();
    const dlg = op.getByRole('dialog');
    await dlg.getByLabel('タイトル').fill(title);
    await dlg.getByLabel('種類').selectOption({ label: kind });
    await dlg.getByRole('button', { name: '保存' }).click();
    await expect(op.getByTestId(`op-request-${title}`)).toBeVisible();
  }
  const url = await issueInviteUI(op, pid);

  // 顧客（iPhone）
  const { page: cl } = await openInvite(browser, url, clientEmail);
  await expect(cl.getByText('資料のご提出（未提出 3件）')).toBeVisible();
  await cl.getByTestId('todo-requests').click();
  const logo = cl.getByTestId('request-ロゴ');
  await logo.getByTestId('file-input').setInputFiles(SAMPLE('logo.png'));
  await expect(logo.getByText('samplecreative_logo.png').or(logo.getByText('logo.png'))).toBeVisible();
  await logo.getByRole('button', { name: 'この内容で提出する' }).click();
  await expect(logo.getByText('提出済み')).toBeVisible();
  const text = cl.getByTestId('request-掲載文');
  await text.getByLabel('回答').fill('実りの秋、ごほうび時間。');
  await text.getByRole('button', { name: 'この内容で提出する' }).click();
  await expect(text.getByText('提出済み')).toBeVisible();
  const u = cl.getByTestId('request-参考URL');
  await u.getByLabel('URL').fill('https://example.com/reference');
  await u.getByRole('button', { name: 'この内容で提出する' }).click();
  await expect(u.getByText('提出済み')).toBeVisible();
  await expect(cl.getByText('3/3 提出済み')).toBeVisible();

  // 運営者が確認
  await op.goto('/app');
  await expect(op.getByTestId('bucket-toReviewMaterials').getByText('3')).toBeVisible();
  await op.goto(`/app/projects/${pid}?tab=requests`);
  for (const t of ['ロゴ', '掲載文', '参考URL']) {
    await op.getByTestId(`op-request-${t}`).getByRole('button', { name: '✓ 確認済みにする' }).click();
    await expect(op.getByTestId(`op-request-${t}`).getByText('確認済み', { exact: true })).toBeVisible();
  }
  // 制作開始
  await op.getByRole('tab', { name: '概要' }).click();
  await op.getByLabel('状態').selectOption({ label: '制作中' });
  await op.getByRole('button', { name: '変更' }).click();
  await expect(op.locator('.badge', { hasText: '制作中' }).first()).toBeVisible();
  await cl.goto(`/portal/p/${pid}`);
  await expect(cl.getByText('制作中').first()).toBeVisible();
});

test('E2E-2: v1提出→顧客が画像ピン2件+修正依頼→v2提出→顧客承認（ピン座標は端末間で一致）', async ({ browser }) => {
  const { page: op } = await signupOperator(browser);
  const email = `${uniq('c')}@example.com`;
  const pid = await createProjectUI(op, email, 'ピン確認案件');
  const url = await issueInviteUI(op, pid);
  const did = await addDeliverableUI(op, pid, '投稿画像A', SAMPLE('post-a-v1.png'));

  const { page: cl } = await openInvite(browser, url, email);
  await expect(cl.getByTestId('todo-review')).toBeVisible();
  await cl.getByTestId('todo-review').click();
  const img = cl.getByTestId('pin-image').locator('img');
  await expect(img).toBeVisible();
  for (const [rx, ry, body] of [
    [0.5, 0.2, 'キャッチコピーを大きく'],
    [0.7, 0.78, 'ロゴを右下へ'],
  ] as const) {
    await cl.getByTestId('pin-mode').click();
    const box = (await img.boundingBox())!;
    await cl.getByTestId('pin-image').click({ position: { x: box.width * rx, y: box.height * ry } });
    await cl.getByTestId('comment-input').fill(body);
    await cl.getByRole('button', { name: 'コメントを送信' }).click();
    await expect(cl.getByText(body)).toBeVisible();
  }
  await expect(cl.getByTestId('pin-1')).toBeVisible();
  await expect(cl.getByTestId('pin-2')).toBeVisible();
  const mobileLeft = await cl.getByTestId('pin-2').evaluate((e) => (e as HTMLElement).style.left);
  await cl.getByTestId('change-open').click();
  await cl.getByTestId('change-body').fill('ピンの2点を修正してください');
  await cl.getByRole('button', { name: '修正を依頼する' }).click();
  await expect(cl.getByText('この版への修正依頼')).toBeVisible();

  // 運営者PC: 同じ相対位置に表示される
  await op.goto(`/app/projects/${pid}/deliverables/${did}`);
  await expect(op.getByTestId('pin-2')).toBeVisible();
  expect(await op.getByTestId('pin-2').evaluate((e) => (e as HTMLElement).style.left)).toBe(mobileLeft);
  const pcImg = (await op.getByTestId('pin-image').locator('img').boundingBox())!;
  const pinBox = (await op.getByTestId('pin-2').boundingBox())!;
  // ピン中心が画像の約70%/78%の位置にあること（表示サイズに依存しない）
  expect(Math.abs((pinBox.x + pinBox.width / 2 - pcImg.x) / pcImg.width - 0.7)).toBeLessThan(0.03);
  expect(Math.abs((pinBox.y + pinBox.height / 2 - pcImg.y) / pcImg.height - 0.78)).toBeLessThan(0.03);
  await expect(op.getByText('ピンの2点を修正してください')).toBeVisible();

  await submitNewVersionUI(op, pid, did, SAMPLE('post-a-v2.png'), 'ご指摘の2点を修正しました');
  await approveUI(cl, pid, did);
  await expect(cl.getByText('v2 を承認いただきました', { exact: false })).toBeVisible();
});

test('E2E-3: 承認済み制作物2件→最終納品→顧客ZIP取得→ダウンロード履歴', async ({ browser }) => {
  const { page: op } = await signupOperator(browser);
  const email = `${uniq('c')}@example.com`;
  const pid = await createProjectUI(op, email, '納品案件');
  const url = await issueInviteUI(op, pid);
  const dA = await addDeliverableUI(op, pid, '投稿画像A', SAMPLE('post-a-v2.png'));
  const dB = await addDeliverableUI(op, pid, '投稿画像B', SAMPLE('post-b-v1.png'));
  const { page: cl } = await openInvite(browser, url, email, ANDROID);
  await approveUI(cl, pid, dA);
  await approveUI(cl, pid, dB);

  await op.goto(`/app/projects/${pid}?tab=deliveries`);
  await op.getByRole('button', { name: '＋ 納品セットを作成' }).click();
  const dlg = op.getByRole('dialog', { name: '納品セットを作成' });
  await expect(dlg.getByRole('checkbox')).toHaveCount(2);
  await dlg.getByLabel('注意文（利用範囲など）').fill('SNS投稿用です');
  await dlg.getByRole('button', { name: '下書きとして作成' }).click();
  await op.getByRole('button', { name: '内容を確認して公開' }).click();
  await expect(op.getByRole('dialog', { name: '公開前の確認' }).getByText('投稿画像A v1')).toBeVisible();
  await op.getByRole('button', { name: '公開する' }).click();
  await expect(op.getByTestId('op-delivery').getByText('公開中')).toBeVisible();

  await cl.goto(`/portal/p/${pid}/deliveries`);
  const [dl] = await Promise.all([cl.waitForEvent('download'), cl.getByTestId('zip-download').click()]);
  const zipPath = await dl.path();
  const entries = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(zipPath!))));
  expect(entries.sort()).toEqual(['最終納品/投稿画像A_v1.png', '最終納品/投稿画像B_v1.png']);

  await op.goto(`/app/projects/${pid}?tab=activity`);
  await expect(op.getByText('を一括ダウンロード（2件）', { exact: false })).toBeVisible();
  await cl.goto(`/portal/p/${pid}/activity`);
  await expect(cl.getByText('を一括ダウンロード（2件）', { exact: false })).toBeVisible();
});

test('E2E-4: v1承認後にv2提出→承認は引継がれず再承認が必要、旧版は承認できない', async ({ browser }) => {
  const { page: op } = await signupOperator(browser);
  const email = `${uniq('c')}@example.com`;
  const pid = await createProjectUI(op, email, '再承認案件');
  const url = await issueInviteUI(op, pid);
  const did = await addDeliverableUI(op, pid, 'バナー', SAMPLE('post-a-v1.png'));
  const { page: cl } = await openInvite(browser, url, email);
  await approveUI(cl, pid, did);

  // 顧客が承認ダイアログを開いたまま、運営者が v2 を提出
  await cl.goto(`/portal/p/${pid}/review/${did}`);
  await submitNewVersionUI(op, pid, did, SAMPLE('post-a-v2.png'), '差し替え版');
  await cl.reload();
  await expect(cl.getByRole('tab', { name: 'v2（最新）' })).toBeVisible();
  await expect(cl.getByTestId('approve-open')).toBeVisible(); // v2は未承認
  await cl.getByRole('tab', { name: 'v1（旧版）' }).click();
  await expect(cl.getByText('これは旧版（v1）です')).toBeVisible();
  await expect(cl.getByTestId('approve-open')).toHaveCount(0);
  await expect(cl.getByText('承認履歴（v1）')).toBeVisible();

  // 古い画面から直接v1承認を送っても拒否（APIレベル）
  const detail = await apiCall(cl, 'GET', `/api/portal/projects/${pid}/deliverables/${did}`);
  const v1 = detail.body.deliverable.versions.find((v: { versionNumber: number }) => v.versionNumber === 1);
  const r = await apiCall(cl, 'POST', `/api/portal/projects/${pid}/versions/${v1.id}/approve`, { idempotencyKey: 'aaaaaaaaaaaaaaaaaaaa', expectedVersionNumber: 1, confirm: true });
  expect(r.status).toBe(409);
  await cl.goto(`/portal/p/${pid}`);
  await expect(cl.getByText('バナー v2 をご確認ください')).toBeVisible();
  await approveUI(cl, pid, did);
  await expect(cl.getByText('v2 を承認いただきました', { exact: false })).toBeVisible();
});

test('E2E-5: 顧客Aの招待URL/案件IDを顧客Bが利用→拒否', async ({ browser }) => {
  const { page: op } = await signupOperator(browser);
  const emailA = `${uniq('a')}@example.com`;
  const emailB = `${uniq('b')}@example.com`;
  const pidA = await createProjectUI(op, emailA, '顧客Aの案件', 'A社');
  const urlA = await issueInviteUI(op, pidA);
  const pidB = await createProjectUI(op, emailB, '顧客Bの案件', 'B社');
  const urlB = await issueInviteUI(op, pidB);
  const { page: b } = await openInvite(browser, urlB, emailB);
  // Aの招待URLをBが開いてもメール照合で拒否
  await b.goto(urlA);
  await b.getByRole('textbox').fill(emailB);
  await b.getByRole('button', { name: 'ページを開く' }).click();
  await expect(b.getByText('メールアドレスが招待先と一致しません')).toBeVisible();
  // Aの案件IDをURLに入れても表示されない
  await b.goto(`/portal/p/${pidA}`);
  await expect(b.getByText('案件が見つかりません')).toBeVisible();
  await expect(b.getByText('顧客Aの案件')).toHaveCount(0);
  const r = await apiCall(b, 'GET', `/api/portal/projects/${pidA}`);
  expect(r.status).toBe(404);
  // 顧客は管理画面APIにアクセスできない
  expect((await apiCall(b, 'GET', '/api/app/projects')).status).toBe(401);
  await b.goto('/app');
  await expect(b).toHaveURL(/\/login/);
});

test('E2E-6: iPhoneで写真アップロード→PCで確認→PCで制作物提出→iPhoneでコメント/承認', async ({ browser }) => {
  const { page: pc } = await signupOperator(browser);
  const email = `${uniq('c')}@example.com`;
  const pid = await createProjectUI(pc, email, 'スマホ連携案件');
  await apiCall(pc, 'POST', `/api/app/projects/${pid}/requests`, { title: '商品写真', kind: 'file' });
  const url = await issueInviteUI(pc, pid);
  const { page: ip } = await openInvite(browser, url, email, IPHONE);
  await ip.goto(`/portal/p/${pid}/requests`);
  const card = ip.getByTestId('request-商品写真');
  // 「写真・動画を選ぶ」の入力（accept=image/*,video/*）
  await card.locator('input[accept="image/*,video/*"]').setInputFiles(SAMPLE('product.png'));
  await expect(card.getByText('product.png')).toBeVisible();
  await card.getByRole('button', { name: 'この内容で提出する' }).click();
  await expect(card.getByText('提出済み')).toBeVisible();

  await pc.goto(`/app/projects/${pid}?tab=requests`);
  const opCard = pc.getByTestId('op-request-商品写真');
  await expect(opCard.getByText('product.png')).toBeVisible();
  const imgSrc = await opCard.locator('img').getAttribute('src');
  const imgRes = await pc.request.get(imgSrc!);
  expect(imgRes.status()).toBe(200);
  expect(imgRes.headers()['content-type']).toBe('image/png');
  await opCard.getByRole('button', { name: '✓ 確認済みにする' }).click();

  const did = await addDeliverableUI(pc, pid, 'EC用バナー', SAMPLE('post-b-v1.png'));
  await ip.goto(`/portal/p/${pid}/review/${did}`);
  await ip.getByTestId('comment-input').fill('とても良いです');
  await ip.getByRole('button', { name: 'コメントを送信' }).click();
  await expect(ip.getByText('とても良いです')).toBeVisible();
  await approveUI(ip, pid, did);
  await pc.goto(`/app/projects/${pid}/deliverables/${did}`);
  await expect(pc.getByText('とても良いです')).toBeVisible();
  await expect(pc.getByText('により承認済みです', { exact: false })).toBeVisible();
});

test('E2E-7: バックアップ→空環境へ復元→案件/version/ファイル/コメント/承認ハッシュ/納品が一致', async ({ browser }) => {
  const { page: op, email: opEmail } = await signupOperator(browser);
  const s = await apiCall(op, 'POST', '/api/app/sample');
  expect(s.status).toBe(200);
  const pid = s.body.projectId;
  const before = await apiCall(op, 'GET', `/api/app/projects/${pid}`);

  const root = ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-bk-'));
  const env = { ...process.env, DATA_DIR: path.join(root, '.e2e-data'), NODE_ENV: 'development' };
  const out = execFileSync('node', ['dist/scripts/backup.js', tmp], { cwd: root, env }).toString();
  const bk = JSON.parse(out.slice(out.indexOf('{')));
  expect(bk.ok).toBe(true);
  const restoreDir = path.join(tmp, 'restored-data');
  execFileSync('node', ['dist/scripts/restore.js', bk.dir], { cwd: root, env: { ...env, DATA_DIR: restoreDir } });

  const port = 8795;
  const server = spawn('node', ['dist/server/src/main.js'], {
    cwd: root,
    env: { ...env, DATA_DIR: restoreDir, PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, LOG_LEVEL: 'warn', DISABLE_RATE_LIMIT: 'true' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://localhost:${port}/api/health`);
        if (r.ok) break;
      } catch {
        /* wait */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const ctx = await browser.newContext({ baseURL: `http://localhost:${port}` });
    const p2 = await ctx.newPage();
    await p2.goto('/login');
    await p2.getByLabel('メールアドレス').fill(opEmail);
    await p2.getByLabel('パスワード').fill(PASSWORD);
    await p2.getByRole('button', { name: 'ログイン' }).click();
    await p2.waitForURL('**/app');
    const after = await apiCall(p2, 'GET', `/api/app/projects/${pid}`);
    expect(after.status).toBe(200);
    const pick = (d: typeof before.body) => ({
      project: [d.project.name, d.project.status],
      versions: d.deliverables.map((x: { title: string; versions: { versionNumber: number; status: string; file: { sha256: string }; approval: { fileSha256: string } | null; commentCount: number }[] }) =>
        x.versions.map((v) => [x.title, v.versionNumber, v.status, v.file.sha256, v.approval?.fileSha256 ?? null, v.commentCount]),
      ),
      deliveries: d.deliveries.map((x: { title: string; status: string; items: { file: { sha256: string } }[] }) => [x.title, x.status, x.items.map((i) => i.file.sha256)]),
      requests: d.requests.map((r: { title: string; status: string; files: { sha256: string }[] }) => [r.title, r.status, r.files.map((f) => f.sha256)]),
    });
    expect(pick(after.body)).toEqual(pick(before.body));
    // 画面上でもサンプル案件のピンコメントが見える
    const dA = after.body.deliverables.find((x: { title: string }) => x.title === '投稿画像A');
    await p2.goto(`/app/projects/${pid}/deliverables/${dA.id}`);
    await p2.getByRole('tab', { name: 'v1（旧版）' }).click();
    await expect(p2.getByTestId('pin-2')).toBeVisible();
    // ファイル実体のバイト一致
    const f = after.body.deliverables[0].versions[0].file;
    const a = await (await op.request.get(before.body.deliverables[0].versions[0].file.url)).body();
    const b = await (await p2.request.get(f.url)).body();
    expect(Buffer.compare(a, b)).toBe(0);
    await ctx.close();
  } finally {
    server.kill();
  }
});

test('オフライン: 送信を無効化し、コメントは未送信の下書きとして保持', async ({ browser }) => {
  const { page: op } = await signupOperator(browser);
  const email = `${uniq('c')}@example.com`;
  const pid = await createProjectUI(op, email, 'オフライン案件');
  const url = await issueInviteUI(op, pid);
  const did = await addDeliverableUI(op, pid, '資料', SAMPLE('post-a-v1.png'));
  const { ctx, page: cl } = await openInvite(browser, url, email);
  await cl.goto(`/portal/p/${pid}/review/${did}`);
  await expect(cl.getByTestId('comment-input')).toBeVisible();
  await ctx.setOffline(true);
  await expect(cl.getByText('オフラインです。表示中の内容は古い可能性があります', { exact: false })).toBeVisible();
  await cl.getByTestId('comment-input').fill('電車の中で書いたコメント');
  await expect(cl.getByText('未送信の下書き')).toBeVisible();
  await expect(cl.getByRole('button', { name: 'コメントを送信' })).toBeDisabled();
  await cl.getByTestId('approve-open').click();
  await cl.getByTestId('approve-check').check();
  await expect(cl.getByRole('button', { name: '承認する' })).toBeDisabled();
  await cl.keyboard.press('Escape');
  await ctx.setOffline(false);
  await cl.reload();
  // 再接続後も下書きは残る（自動送信しない）
  await expect(cl.getByTestId('comment-input')).toHaveValue('電車の中で書いたコメント');
  const d = await apiCall(cl, 'GET', `/api/portal/projects/${pid}/deliverables/${did}`);
  expect(Object.values(d.body.comments).flat()).toHaveLength(0);
});

test('PWA: manifest・Service Worker・アイコン', async ({ page }) => {
  await page.goto('/login');
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/', lang: 'ja' });
  for (const i of manifest.icons) expect((await page.request.get(i.src)).status()).toBe(200);
  expect((await page.request.get('/icons/apple-touch-icon.png')).status()).toBe(200);
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    return !!r.active;
  });
  expect(reg).toBe(true);
  const sw = await (await page.request.get('/sw.js')).text();
  expect(sw).toContain("url.pathname.startsWith('/api/')) return");
});

test('運営者スマホ（iPhone）: 案件確認・制作物提出・コメント返信・下部ナビ', async ({ browser }) => {
  const { page: op } = await signupOperator(browser, { mobile: true });
  const email = `${uniq('c')}@example.com`;
  const pid = await createProjectUI(op, email, 'スマホ運営案件');
  const url = await issueInviteUI(op, pid);
  const did = await addDeliverableUI(op, pid, 'ストーリーズ画像', SAMPLE('post-b-v1.png'));
  const { page: cl } = await openInvite(browser, url, email, ANDROID);
  await cl.goto(`/portal/p/${pid}/review/${did}`);
  await cl.getByTestId('comment-input').fill('色味を少し明るくできますか？');
  await cl.getByRole('button', { name: 'コメントを送信' }).click();
  await expect(cl.getByText('色味を少し明るくできますか？')).toBeVisible();
  // 運営者スマホ: 下部ナビから通知 → 返信
  await op.goto('/app');
  const bottom = op.getByRole('navigation', { name: 'メインメニュー' }).last();
  await expect(bottom).toBeVisible();
  await bottom.getByRole('link', { name: /通知/ }).click();
  await op.getByText('コメントしました', { exact: false }).first().click();
  await op.waitForURL(/deliverables/);
  await op.getByRole('button', { name: '返信' }).first().click();
  await op.getByTestId('comment-input').fill('承知しました。明るくした版を提出します');
  await op.getByRole('button', { name: 'コメントを送信' }).click();
  await expect(op.getByText('承知しました。明るくした版を提出します')).toBeVisible();
  // 横スクロールが発生しない（PC画面の縮小ではない）
  const overflow = await op.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await cl.reload();
  await expect(cl.getByText('承知しました。明るくした版を提出します')).toBeVisible();
});

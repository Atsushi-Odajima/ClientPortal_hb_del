import { expect, type Browser, type BrowserContext, type Page, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SAMPLE = (n: string) => path.join(ROOT, 'server/assets/sample', n);
export const IPHONE = devices['iPhone 13'];
export const ANDROID = devices['Pixel 7'];
export const PASSWORD = 'correct horse battery';

let seq = 0;
export function uniq(prefix: string) {
  seq++;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}

/** 運営者をUIから登録してログイン済みのページを返す */
export async function signupOperator(browser: Browser, opts: { mobile?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page; email: string }> {
  const ctx = await browser.newContext(opts.mobile ? { ...IPHONE } : { viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const email = `${uniq('op')}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('氏名').fill('小田 制作');
  await page.getByLabel('屋号・会社名（お客様の画面に表示されます）').fill('オダ デザイン');
  await page.getByLabel('メールアドレス（ログインID）').fill(email);
  await page.getByLabel('パスワード（10文字以上）').fill(PASSWORD);
  await page.getByRole('button', { name: 'アカウントを作成' }).click();
  await page.waitForURL('**/app');
  return { ctx, page, email };
}

/** APIを直接叩く（ページのCookieを共有） */
export async function apiCall(page: Page, method: string, url: string, data?: unknown) {
  const res = await page.request.fetch(url, {
    method,
    headers: { 'x-cp-csrf': '1', 'content-type': 'application/json' },
    data: data === undefined ? (method === 'GET' ? undefined : {}) : data,
  });
  const body = res.headers()['content-type']?.includes('json') ? await res.json() : await res.body();
  return { status: res.status(), body };
}

/** UIで顧客＋案件を作成 */
export async function createProjectUI(page: Page, clientEmail: string, projectName: string, company = 'Sample Creative株式会社') {
  await page.goto('/app/projects?new=1');
  const dlg = page.getByRole('dialog', { name: '新しい案件' });
  await dlg.locator('select').first().selectOption('__new');
  await dlg.getByLabel('会社名・屋号').fill(company);
  await dlg.getByLabel('担当者名').fill('見本 花子');
  await dlg.getByLabel('メールアドレス（招待時の本人確認に使います）').fill(clientEmail);
  await dlg.getByLabel('案件名').fill(projectName);
  await dlg.getByRole('button', { name: '作成する' }).click();
  await page.waitForURL(/\/app\/projects\/prj_/);
  return page.url().split('/app/projects/')[1].split('?')[0];
}

export async function issueInviteUI(page: Page, projectId: string): Promise<string> {
  await page.goto(`/app/projects/${projectId}?tab=share`);
  await page.getByRole('button', { name: /招待リンクを(再)?発行/ }).click();
  const url = (await page.getByTestId('invite-url').textContent())!.trim();
  expect(url).toMatch(/\/invite#t=/);
  return url;
}

export async function openInvite(browser: Browser, url: string, email: string, device = IPHONE): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ ...device });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByRole('textbox').fill(email);
  await page.getByRole('button', { name: 'ページを開く' }).click();
  await page.waitForURL(/\/portal\/p\/prj_/);
  // トークンはアドレスバーに残らない
  expect(page.url()).not.toContain('#t=');
  return { ctx, page };
}

/** 運営者UIで制作物を追加し v1 を提出 */
export async function addDeliverableUI(page: Page, projectId: string, title: string, file: string) {
  await page.goto(`/app/projects/${projectId}?tab=deliverables`);
  await page.getByRole('button', { name: '＋ 制作物' }).click();
  const dlg = page.getByRole('dialog', { name: '制作物を追加' });
  await dlg.getByLabel('制作物名').fill(title);
  await dlg.getByRole('button', { name: '追加して版を提出へ' }).click();
  await page.waitForURL(/deliverables\/dlv_/);
  const did = page.url().split('/deliverables/')[1];
  await page.getByLabel('説明（顧客に表示）').fill(`${title} 初稿です`);
  await page.getByTestId('file-input').setInputFiles(file);
  await expect(page.getByText('v1 を提出しました', { exact: false })).toBeVisible();
  return did;
}

export async function submitNewVersionUI(page: Page, projectId: string, did: string, file: string, note: string) {
  await page.goto(`/app/projects/${projectId}/deliverables/${did}`);
  await page.getByRole('button', { name: '開く' }).click();
  await page.getByLabel('説明（顧客に表示）').fill(note);
  await page.getByTestId('file-input').setInputFiles(file);
  await expect(page.getByText('を提出しました', { exact: false })).toBeVisible();
}

export async function approveUI(page: Page, projectId: string, did: string) {
  await page.goto(`/portal/p/${projectId}/review/${did}`);
  await page.getByTestId('approve-open').click();
  await page.getByTestId('approve-check').check();
  await page.getByRole('button', { name: '承認する' }).click();
  await expect(page.getByText('承認いただきました', { exact: false })).toBeVisible();
}

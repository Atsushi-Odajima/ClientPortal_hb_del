import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

// この環境ではプリインストールの Chromium を使う（CHROMIUM_PATH で上書き可）
const exe = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = Number(process.env.E2E_PORT ?? 8790);

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: fs.existsSync(exe) ? { executablePath: exe } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  },
  webServer: {
    command: `rm -rf .e2e-data && node dist/server/src/main.js`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: String(PORT),
      DATA_DIR: '.e2e-data',
      PUBLIC_URL: `http://localhost:${PORT}`,
      ALLOW_SIGNUP: 'true',
      LOG_LEVEL: 'warn',
      PASSWORD_SCRYPT_N: '16384',
      NODE_ENV: 'development',
      DISABLE_RATE_LIMIT: 'true',
    },
  },
});

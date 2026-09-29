// サンプル画像・PWAアイコンを生成（開発時に1回実行し、成果物をリポジトリに含める）
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined });
const page = await browser.newPage();

async function shot(html, w, h, out, type = 'png') {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0">${html}</body></html>`);
  await page.screenshot({ path: out, type, quality: type === 'jpeg' ? 82 : undefined, omitBackground: false });
  console.log('wrote', out);
}

const font = `font-family: 'Noto Sans CJK JP','Hiragino Sans',sans-serif;`;
const post = (title, sub, titleSize, logoRight, logoBottom, bg) => `
<div style="width:800px;height:800px;position:relative;background:${bg};${font};overflow:hidden">
  <div style="position:absolute;inset:0;background:radial-gradient(circle at 30% 70%, rgba(255,255,255,.25), transparent 55%)"></div>
  <div style="position:absolute;top:120px;left:0;right:0;text-align:center;color:#fff;font-weight:800;font-size:${titleSize}px;letter-spacing:.04em;text-shadow:0 3px 12px rgba(0,0,0,.25)">${title}</div>
  <div style="position:absolute;top:${150 + titleSize}px;left:0;right:0;text-align:center;color:#fff8ec;font-size:30px">${sub}</div>
  <div style="position:absolute;left:250px;top:330px;width:300px;height:300px;border-radius:24px;background:linear-gradient(135deg,#fff3dc,#e9c48c);box-shadow:0 20px 40px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;color:#8a4b1f;font-size:34px;font-weight:700">秋限定<br>パッケージ</div>
  <div style="position:absolute;right:${logoRight}px;bottom:${logoBottom}px;background:#fff;color:#c8553d;font-weight:800;padding:10px 16px;border-radius:10px;font-size:22px">Sample Creative</div>
</div>`;

await shot(post('実りの秋、ごほうび時間。', '秋限定パッケージ登場', 46, 140, 150, 'linear-gradient(160deg,#c8553d,#e8a33d)'), 800, 800, 'server/assets/sample/post-a-v1.png');
await shot(post('実りの秋、ごほうび時間。', '秋限定パッケージ登場', 60, 40, 40, 'linear-gradient(160deg,#c8553d,#e8a33d)'), 800, 800, 'server/assets/sample/post-a-v2.png');
await shot(post('今だけの秋色。', '数量限定・オンライン先行', 56, 40, 40, 'linear-gradient(160deg,#6b4c9a,#c8553d)'), 800, 800, 'server/assets/sample/post-b-v1.png');
await shot(`<div style="width:600px;height:240px;background:#fff;display:flex;align-items:center;justify-content:center;gap:18px;${font}">
  <div style="width:96px;height:96px;border-radius:50%;background:#c8553d;color:#fff;font-size:54px;font-weight:800;display:flex;align-items:center;justify-content:center">S</div>
  <div style="font-size:48px;font-weight:800;color:#333">Sample Creative</div></div>`, 600, 240, 'server/assets/sample/logo.png');
await shot(`<div style="width:900px;height:600px;background:linear-gradient(180deg,#f5ede3,#e7d3bb);display:flex;align-items:center;justify-content:center;${font}">
  <div style="width:360px;height:420px;border-radius:28px;background:linear-gradient(135deg,#fff3dc,#e9c48c);box-shadow:0 30px 60px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;color:#8a4b1f;font-size:44px;font-weight:800;text-align:center">秋限定<br>パッケージ</div></div>`, 900, 600, 'server/assets/sample/product.png');

// PWAアイコン
const icon = (size, pad) => `<div style="width:${size}px;height:${size}px;background:#2f5d8a;display:flex;align-items:center;justify-content:center">
  <div style="width:${size - pad * 2}px;height:${size - pad * 2}px;display:flex;align-items:center;justify-content:center;flex-direction:column;color:#fff;${font}">
   <svg viewBox="0 0 64 64" width="${(size - pad * 2) * 0.62}" height="${(size - pad * 2) * 0.62}"><rect x="8" y="10" width="48" height="40" rx="6" fill="none" stroke="#fff" stroke-width="5"/><path d="M20 30l8 8 16-16" fill="none" stroke="#9fe0b0" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </div></div>`;
await shot(icon(192, 16), 192, 192, 'web/public/icons/icon-192.png');
await shot(icon(512, 40), 512, 512, 'web/public/icons/icon-512.png');
await shot(icon(512, 110), 512, 512, 'web/public/icons/maskable-512.png');
await shot(icon(180, 14), 180, 180, 'web/public/icons/apple-touch-icon.png');
await browser.close();

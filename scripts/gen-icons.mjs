// 由 assets/logo.svg 生成扩展图标 PNG：npm run icons
// 用 Playwright 自带的 Chromium 栅格化，保证与浏览器中看到的 SVG 完全一致
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const svg = readFileSync(new URL('assets/logo.svg', root), 'utf8');
const outDir = fileURLToPath(new URL('public/icon/', root));
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 96, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}</style>` +
      `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}">`,
  );
  await page.locator('img').screenshot({ path: `${outDir}${size}.png`, omitBackground: true });
  console.log(`public/icon/${size}.png`);
}
await browser.close();

// 生成 README 用的截图：npm run build && npm run screenshots
// 用真实的扩展构建 + 一个本地演示页面；翻译接口是本地模拟的 OpenAI 兼容服务，返回预先写好的中文译文。
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const EXT = fileURLToPath(new URL('.output/chrome-mv3', root));
const OUT = fileURLToPath(new URL('docs/images/', root));
mkdirSync(OUT, { recursive: true });

const T = {
  'The quiet power of reading in two languages': '双语阅读的力量',
  'Most translation tools replace the page you are reading. That is convenient, but it also hides the original words, and with them the nuance the author chose.':
    '大多数翻译工具会直接替换你正在读的页面。这很方便，但也把原文藏了起来，连同作者精心挑选的细微含义。',
  'Bilingual reading takes a different approach. Each paragraph keeps its original text, and the translation appears right below it, so you can glance back whenever a sentence feels off.':
    '双语阅读换了一种方式：每个段落都保留原文，译文就显示在它的正下方。哪句话读着别扭，随时可以回头看一眼原文。',
  'Over time, this turns every article into a small language lesson. You notice how ideas are phrased, pick up vocabulary in context, and rely less and less on the translation.':
    '久而久之，每篇文章都成了一堂小小的语言课：你会留意观点是怎样表达的，在语境中积累词汇，也越来越少依赖译文。',
  'Getting started': '快速上手',
  'Open any page and click the floating button.': '打开任意网页，点击悬浮按钮。',
  'Press Alt+A to switch between bilingual and original.': '按 Alt+A 在双语和原文之间切换。',
  'Pick a translation engine that fits your budget and privacy needs.': '选择适合你预算和隐私需求的翻译引擎。',
};

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reading in two languages</title>
<style>
  body { margin: 0; font: 18px/1.75 Georgia, 'Times New Roman', serif; color: #1d1d1f; background: #fbfaf7; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 18px 48px; border-bottom: 1px solid #e8e4dc;
    font: 15px system-ui, sans-serif; }
  header b { font-size: 17px; } header nav a { margin-left: 22px; color: #555; text-decoration: none; }
  main { max-width: 700px; margin: 48px auto 80px; padding: 0 24px; }
  h1 { font-size: 40px; line-height: 1.2; margin: 0 0 8px; }
  .meta { font: 14px system-ui, sans-serif; color: #888; margin-bottom: 28px; }
  h2 { font-size: 26px; margin-top: 36px; }
  pre { background: #f0ede6; padding: 14px 18px; border-radius: 8px; font-size: 15px; }
</style></head><body>
<header><b>Field Notes</b><nav><a href="#">Articles</a><a href="#">Newsletter</a><a href="#">About</a></nav></header>
<main><article>
  <h1>The quiet power of reading in two languages</h1>
  <div class="meta">Nov 27, 2026 · 4 min read</div>
  <p>Most translation tools replace the page you are reading. That is convenient, but it also hides the original words, and with them the nuance the author chose.</p>
  <p>Bilingual reading takes a different approach. Each paragraph keeps its original text, and the translation appears right below it, so you can glance back whenever a sentence feels off.</p>
  <p>Over time, this turns every article into a small language lesson. You notice how ideas are phrased, pick up vocabulary in context, and rely less and less on the translation.</p>
  <h2>Getting started</h2>
  <ul>
    <li>Open any page and click the floating button.</li>
    <li>Press Alt+A to switch between bilingual and original.</li>
    <li>Pick a translation engine that fits your budget and privacy needs.</li>
  </ul>
  <pre><code>git clone https://github.com/wianger/bilingo</code></pre>
</article></main></body></html>`;

const server = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
  if (!req.url?.includes('chat/completions')) return res.writeHead(404).end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const user = JSON.parse(body).messages.at(-1).content;
    let content;
    try {
      const { segments } = JSON.parse(user);
      content = JSON.stringify({ translations: segments.map((s) => ({ id: s.id, text: T[s.text] ?? s.text })) });
    } catch {
      content = T[user] ?? user;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const site = `http://blog.example.com:${port}/`;

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  deviceScaleFactor: 2,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--host-resolver-rules=MAP blog.example.com 127.0.0.1`,
    `--no-proxy-server`,
  ],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
await sw.evaluate(async (baseUrl) => {
  await chrome.storage.local.set({
    settings: { provider: 'openai', targetLang: 'zh-CN', openai: { baseUrl, apiKey: 'demo', model: 'deepseek-chat' } },
  });
}, `http://127.0.0.1:${port}/v1`);

// 1. 双语页面
const page = await context.newPage();
await page.setViewportSize({ width: 1200, height: 860 });
await page.goto(site);
await page.locator('#bilingo-host .ball').click();
await page.locator('li:last-child .bilingo-tr').waitFor();
await page.mouse.move(600, 840);
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}demo.png` });
console.log('docs/images/demo.png');

// 2. 弹窗：让弹窗把演示页当作"当前标签页"
const popup = await context.newPage();
await popup.addInitScript(() => {
  const query = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async () => (await query({ url: 'http://blog.example.com/*' })).slice(0, 1);
});
await popup.setViewportSize({ width: 340, height: 400 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.locator('main').waitFor();
await popup.waitForTimeout(500);
await popup.locator('main').screenshot({ path: `${OUT}popup.png` });
console.log('docs/images/popup.png');

// 3. 设置页
const options = await context.newPage();
await options.setViewportSize({ width: 1200, height: 1000 });
await options.goto(`chrome-extension://${extId}/options.html`);
await options.locator('label.provider', { hasText: '本地大模型' }).click();
await options.waitForTimeout(600);
await options.screenshot({ path: `${OUT}options.png` });
console.log('docs/images/options.png');

await context.close();
server.close();

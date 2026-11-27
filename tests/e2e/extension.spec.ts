// 端到端测试：在真实 Chromium 里加载构建产物，用本地模拟的 OpenAI 兼容接口验证整条翻译链路
declare const chrome: { storage: { local: { set(v: unknown): Promise<void> } } };
import { test as base, chromium, expect, type BrowserContext, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const EXT = path.resolve('.output/chrome-mv3');

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>
  <h1>Hello world</h1>
  <p id="p1">The quick brown fox jumps over the lazy dog.</p>
  <p id="zh">这一段已经是中文了。</p>
  <pre id="code">const answer = 42;</pre>
  <ul><li id="li">Short item</li></ul>
  <div id="spacer" style="height:4000px"></div>
  <p id="far">This paragraph is far below the fold.</p>
</body></html>`;

const LAYOUT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>layout</title><style>
  .card { width: 260px; height: 64px; overflow: hidden; border: 1px solid #ccc; }
  .card h3 { margin: 0; font-size: 16px; line-height: 20px; }
  .strip { display: flex; gap: 8px; width: 260px; height: 24px; overflow: hidden; white-space: nowrap; }
</style></head><body>
  <nav id="nav"><a href="#">Home page</a> <a href="#">About us</a></nav>
  <div class="card" id="card"><h3 id="cardTitle">A fairly long card title that already fills the clamped box</h3>
    <p id="cardBody">Card body text that is cut off by the fixed height.</p></div>
  <div class="strip" id="strip"><span id="tab1">Most recent posts</span><span>Top rated posts</span></div>
  <p id="para">A normal paragraph in the flow of the document.</p>
  <p id="ident">useEffectHook</p>
  <button id="btn">Load more comments</button>
</body></html>`;

let server: Server;
let origin = '';
const llmRequests: { segments?: { id: number; text: string }[]; text?: string }[] = [];

function fakeTranslate(t: string) {
  return `【译】${t}`;
}

const test = base.extend<{ context: BrowserContext; sw: Worker }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture 约定写法
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
});

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/layout') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(LAYOUT_PAGE);
    }
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const user = (JSON.parse(body) as { messages: { content: string }[] }).messages[1]!.content;
        let content: string;
        try {
          const { segments } = JSON.parse(user) as { segments: { id: number; text: string }[] };
          llmRequests.push({ segments });
          content = JSON.stringify({ translations: segments.map((s) => ({ id: s.id, text: fakeTranslate(s.text) })) });
        } catch {
          llmRequests.push({ text: user });
          content = fakeTranslate(user);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => server.close());

test('translates a page bilingually with an OpenAI-compatible provider', async ({ context, sw }) => {
  await sw.evaluate(async (baseUrl) => {
    await chrome.storage.local.set({
      settings: { provider: 'openai', targetLang: 'zh-CN', openai: { baseUrl, apiKey: 'test', model: 'mock' } },
    });
  }, `${origin}/v1`);

  const page = await context.newPage();
  await page.goto(`${origin}/page`);

  const ball = page.locator('#bilingo-host').locator('.ball');
  await expect(ball).toBeVisible();
  await ball.click();

  // 视口内段落被翻译，译文插在原文元素内部
  await expect(page.locator('#p1 .bilingo-tr')).toHaveText('【译】The quick brown fox jumps over the lazy dog.');
  await expect(page.locator('h1 .bilingo-tr')).toHaveText('【译】Hello world');
  await expect(page.locator('#li .bilingo-tr.bilingo-inline')).toHaveText('【译】Short item');
  // 已是目标语言 / 代码块不翻译
  await expect(page.locator('#zh .bilingo-tr')).toHaveCount(0);
  await expect(page.locator('#code .bilingo-tr')).toHaveCount(0);
  // 视口外的段落懒加载：还没翻译
  await expect(page.locator('#far .bilingo-tr')).toHaveCount(0);

  await page.locator('#far').scrollIntoViewIfNeeded();
  await expect(page.locator('#far .bilingo-tr')).toHaveText('【译】This paragraph is far below the fold.');

  // 动态插入的内容自动翻译
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'dyn';
    p.textContent = 'Dynamically added paragraph.';
    document.getElementById('far')!.after(p);
  });
  await expect(page.locator('#dyn .bilingo-tr')).toHaveText('【译】Dynamically added paragraph.');

  // 批量请求：没有为每段单独发请求
  const batched = llmRequests.filter((r) => r.segments);
  expect(batched.length).toBeGreaterThan(0);
  expect(batched.some((r) => (r.segments?.length ?? 0) > 1)).toBe(true);

  // 再次点击恢复原文
  await ball.click();
  await expect(page.locator('.bilingo-tr')).toHaveCount(0);
  await expect(page.locator('[data-bilingo]')).toHaveCount(0);
});

test('second visit is served from the persistent cache', async ({ context, sw }) => {
  await sw.evaluate(async (baseUrl) => {
    await chrome.storage.local.set({
      settings: { provider: 'openai', targetLang: 'zh-CN', openai: { baseUrl, apiKey: 'test', model: 'mock' } },
    });
  }, `${origin}/v1`);
  const page = await context.newPage();
  await page.goto(`${origin}/page`);
  await page.locator('#bilingo-host').locator('.ball').click();
  await expect(page.locator('#p1 .bilingo-tr')).toBeVisible();
  const before = llmRequests.length;

  await page.reload();
  await page.locator('#bilingo-host').locator('.ball').click();
  await expect(page.locator('#p1 .bilingo-tr')).toBeVisible();
  expect(llmRequests.length).toBe(before);
});

test('reports whether this Chromium exposes the built-in Translator API', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(`${origin}/page`);
  const info = await page.evaluate(() => ({ translator: 'Translator' in self, detector: 'LanguageDetector' in self }));
  console.log('Built-in AI in test Chromium:', JSON.stringify(info));
});

test('float ball can be dragged, snaps to an edge and remembers its position', async ({ context }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(`${origin}/page`);
  const ball = page.locator('#bilingo-host').locator('.ball');
  await expect(ball).toBeVisible();
  const box0 = (await ball.boundingBox())!;
  expect(box0.x).toBeGreaterThan(900); // 默认在右侧

  // 拖到左上方，松开后应吸附到左边缘，且拖动不触发翻译
  await page.mouse.move(box0.x + 18, box0.y + 18);
  await page.mouse.down();
  await page.mouse.move(300, 250, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await ball.boundingBox())!.x).toBeLessThan(20);
  const box1 = (await ball.boundingBox())!;
  expect(Math.abs(box1.y + 18 - 250)).toBeLessThan(4);
  await expect(page.locator('.bilingo-tr')).toHaveCount(0);

  // 新页面沿用拖动后的位置
  const page2 = await context.newPage();
  await page2.setViewportSize({ width: 1000, height: 800 });
  await page2.goto(`${origin}/page`);
  const ball2 = page2.locator('#bilingo-host').locator('.ball');
  await expect.poll(async () => (await ball2.boundingBox())?.x ?? -1).toBeLessThan(20);
  expect(Math.abs((await ball2.boundingBox())!.y - box1.y)).toBeLessThan(4);

  // 没有移动的按下-松开仍是点击
  await ball2.click();
  await expect(ball2).toHaveClass(/\bon\b/);
});

test('translates only real content and never breaks fixed-size layouts', async ({ context, sw }) => {
  await sw.evaluate(async (baseUrl) => {
    await chrome.storage.local.set({
      settings: { provider: 'openai', targetLang: 'zh-CN', openai: { baseUrl, apiKey: 'test', model: 'mock' } },
    });
  }, `${origin}/v1`);
  const page = await context.newPage();
  await page.goto(`${origin}/layout`);
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
  const cardBefore = await box('#card');
  const stripBefore = await box('#strip');

  await page.locator('#bilingo-host').locator('.ball').click();
  await expect(page.locator('#para .bilingo-tr')).toHaveText('【译】A normal paragraph in the flow of the document.');
  // flex 容器里的每个标签单独翻译，不合并成一句
  await expect(page.locator('#strip')).not.toHaveAttribute('data-bilingo');

  // 界面元素与代码标识符不翻译
  await expect(page.locator('#nav [data-bilingo]')).toHaveCount(0);
  await expect(page.locator('#btn')).not.toHaveAttribute('data-bilingo');
  await expect(page.locator('#ident')).not.toHaveAttribute('data-bilingo');

  // 固定尺寸的卡片和标签条：放不下译文，改为悬停显示，布局尺寸保持不变
  await expect(page.locator('#cardTitle')).toHaveAttribute('data-bilingo', 'hint');
  await expect(page.locator('#tab1')).toHaveAttribute('data-bilingo', 'hint');
  await expect(page.locator('#card .bilingo-tr, #strip .bilingo-tr')).toHaveCount(0);
  expect(await box('#card')).toEqual(cardBefore);
  expect(await box('#strip')).toEqual(stripBefore);

  await page.locator('#cardTitle').hover();
  const bubble = page.locator('#bilingo-host').locator('.bubble');
  await expect(bubble).toBeVisible();
  await expect(bubble.locator('.body')).toContainText('【译】A fairly long card title');
  await page.locator('#para').hover();
  await expect(bubble).toBeHidden();
});

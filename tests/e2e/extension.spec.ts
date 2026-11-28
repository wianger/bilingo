// 端到端测试：在真实 Chromium 里加载构建产物，用本地模拟的 OpenAI 兼容接口验证整条翻译链路
declare const chrome: {
  storage: { local: { set(v: unknown): Promise<void>; get(k: string): Promise<Record<string, unknown>> } };
  tabs: {
    query(q: { url: string }): Promise<{ id?: number }[]>;
    sendMessage(tabId: number, msg: unknown): Promise<unknown>;
  };
};
import { test as base, chromium, expect, type BrowserContext, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const LONG =
  'WebGPU is a modern graphics and compute API for the web that exposes the capabilities of current GPU hardware, ' +
  'designed as the successor to WebGL with a much closer mapping to Vulkan, Metal and Direct3D 12.';
const ARTICLE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>article</title>
<style>.layout { display: flex; gap: 24px; } main { flex: 1; } aside { width: 240px; }</style></head><body>
  <header><a href="/">My Blog</a><nav><a href="/a">Archive</a> <a href="/b">About</a></nav></header>
  <h1 id="title">A long article title about WebGPU</h1>
  <div class="layout">
    <main><article id="post">
      ${[1, 2, 3, 4, 5].map((i) => `<p id="p${i}">${LONG} Paragraph number ${i} continues the story.</p>`).join('')}
    </article></main>
    <aside id="side">
      <h3 id="related">Related posts</h3>
      <ul><li><a href="/x">Another interesting post</a></li><li><a href="/y">Yet another post</a></li></ul>
      <p id="promo">Subscribe to the newsletter to get every new post delivered straight to your inbox.</p>
    </aside>
  </div>
</body></html>`;

/** 生成一个只有文字的最小 PDF（Helvetica 11pt，行距 14pt，段落之间多空 12pt） */
function makePdf(paragraphs: string[][]): Buffer {
  let y = 740;
  const ops = ['BT', '/F1 11 Tf'];
  for (const lines of paragraphs) {
    for (const line of lines) {
      ops.push(`1 0 0 1 72 ${y} Tm (${line}) Tj`);
      y -= 14;
    }
    y -= 12;
  }
  ops.push('ET');
  const stream = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

const PDF_PARAGRAPHS = [
  [
    'Bilingo translates PDF documents while keeping the original layout of every page,',
    'so figures and formulas stay where they are.',
  ],
  ['Each paragraph is replaced with its translation in the same place.'],
];

const VIDEO_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>video</title></head><body>
  <video id="v" style="width:640px;height:360px;background:#000" controls>
    <track kind="subtitles" srclang="en" label="English" src="/subs.vtt" default>
  </video>
</body></html>`;
const VTT = `WEBVTT

00:00.000 --> 00:02.000
<v Instructor>Hello and welcome

00:02.000 --> 00:04.000
to the <i>course</i>.

00:04.000 --> 00:06.000
Let's begin.
`;

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
    if (req.url === '/article') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(ARTICLE_PAGE);
    }
    if (req.url === '/layout') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(LAYOUT_PAGE);
    }
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (req.url === '/video') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(VIDEO_PAGE);
    }
    if (req.url === '/subs.vtt') {
      res.writeHead(200, { 'content-type': 'text/vtt' });
      return res.end(VTT);
    }
    if (req.url === '/paper.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(makePdf(PDF_PARAGRAPHS));
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

test('on article pages only the main content and the headline are translated', async ({ context, sw }) => {
  await sw.evaluate(async (baseUrl) => {
    await chrome.storage.local.set({
      settings: { provider: 'openai', targetLang: 'zh-CN', openai: { baseUrl, apiKey: 'test', model: 'mock' } },
    });
  }, `${origin}/v1`);
  const page = await context.newPage();
  await page.goto(`${origin}/article`);
  await page.locator('#bilingo-host').locator('.ball').click();
  await expect(page.locator('#p1 .bilingo-tr')).toContainText('【译】WebGPU is a modern');
  await expect(page.locator('#title .bilingo-tr')).toHaveText('【译】A long article title about WebGPU');
  // 侧边栏（相关文章、订阅推广）不在正文区域内
  await page.waitForTimeout(500);
  await expect(page.locator('#side [data-bilingo]')).toHaveCount(0);

  // 关闭"只翻译正文"后，侧边栏也会翻译
  await sw.evaluate(async () => {
    const { settings } = (await chrome.storage.local.get('settings')) as { settings: Record<string, unknown> };
    await chrome.storage.local.set({ settings: { ...settings, scope: 'all' } });
  });
  await expect(page.locator('#promo .bilingo-tr')).toBeVisible();
});

test('interface language follows the browser and can be switched in settings', async ({ context, sw }) => {
  const id = new URL(sw.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  // Playwright 的 Chromium 是 en-US：默认英文界面
  await expect(options.locator('h1')).toHaveText('Settings');

  // 在设置页切换为简体中文：立即生效，无需刷新
  await options.locator('select').nth(1).selectOption('zh-CN');
  await expect(options.locator('h1')).toHaveText('设置');
  await expect(options.getByText('只翻译正文')).toBeVisible();

  // 弹窗与网页上的悬浮按钮也跟随（等设置自动保存后）
  await expect
    .poll(() => sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings as { uiLang?: string }))
    .toMatchObject({ uiLang: 'zh-CN' });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await expect(popup.getByText('目标语言')).toBeVisible();
  const page = await context.newPage();
  await page.goto(`${origin}/page`);
  await expect(page.locator('#bilingo-host').locator('.ball')).toHaveAttribute('aria-label', 'Bilingo 翻译');

  // 切回英文
  await options.locator('select').nth(1).selectOption('en');
  await expect(options.locator('h1')).toHaveText('Settings');
  await expect(page.locator('#bilingo-host').locator('.ball')).toHaveAttribute('aria-label', 'Bilingo translate');
});

/** 设置 OpenAI 模拟接口和网站规则 */
async function useMockEngine(sw: Worker, extra: Record<string, unknown> = {}) {
  await sw.evaluate(
    async ([baseUrl, extra]) => {
      await chrome.storage.local.set({
        settings: {
          provider: 'openai',
          targetLang: 'zh-CN',
          openai: { baseUrl, apiKey: 'test', model: 'mock' },
          ...extra,
        },
      });
    },
    [`${origin}/v1`, extra] as const,
  );
}

test('site rules exclude and include areas', async ({ context, sw }) => {
  await useMockEngine(sw, {
    siteRules: [{ id: 'user:t', matches: ['127.0.0.1'], exclude: ['#p5'] }],
  });
  const page = await context.newPage();
  await page.goto(`${origin}/article`);
  await page.locator('#bilingo-host').locator('.ball').click();
  await expect(page.locator('#p1 .bilingo-tr')).toBeVisible();
  await page.locator('#p5').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await expect(page.locator('#p5 [data-bilingo], #p5.bilingo-tr, #p5 .bilingo-tr')).toHaveCount(0);

  // "只翻译这些区域"优先于正文识别：只翻译侧边栏
  await useMockEngine(sw, { siteRules: [{ id: 'user:t', matches: ['127.0.0.1'], include: ['#side'] }] });
  await expect(page.locator('#promo .bilingo-tr')).toBeVisible();
  await expect(page.locator('#p1 .bilingo-tr')).toHaveCount(0);
});

test('picking an area on the page creates a site rule', async ({ context, sw }) => {
  await useMockEngine(sw);
  const page = await context.newPage();
  await page.goto(`${origin}/article`);
  await page.locator('#bilingo-host .ball').waitFor({ state: 'attached' });

  // 相当于在弹窗里点"选择翻译区域…"
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    await chrome.tabs.sendMessage(tab!.id!, { id: 1, type: 'startPicker', data: undefined, timestamp: Date.now() });
  });
  const picker = page.locator('#bilingo-picker');
  await expect(picker.locator('.panel')).toBeVisible();

  // 点击侧边栏里的推广段落，再扩大到整个侧边栏
  await page.locator('#promo').click();
  await expect(picker.locator('input')).toHaveValue('p#promo');
  await picker.getByRole('button', { name: 'Expand' }).click();
  await expect(picker.locator('input')).toHaveValue('aside#side');
  await expect(picker.locator('.count')).toHaveText('Matches on this page: 1');
  await picker.getByRole('button', { name: "Don't translate" }).click();
  await expect(picker).toHaveCount(0);

  // 规则已保存，页面按新规则翻译：正文翻译了，侧边栏没有
  const saved = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  expect((saved as { siteRules: unknown[] }).siteRules).toEqual([
    { id: 'site:127.0.0.1', matches: ['127.0.0.1'], exclude: ['aside#side'] },
  ]);
  await expect(page.locator('#p1 .bilingo-tr')).toBeVisible();
  await expect(page.locator('#side .bilingo-tr')).toHaveCount(0);
});

// ---------- YouTube 双语字幕：本地模拟的 YouTube（HTTPS + 带令牌的字幕接口） ----------

const YT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>yt</title>
<style>#movie_player { position: relative; width: 800px; height: 450px; background: #000; }
video { width: 100%; height: 100%; }</style></head><body>
<div id="movie_player" class="html5-video-player ytp-autohide">
  <video></video>
  <div class="ytp-caption-window-container" id="native">native captions</div>
  <div class="ytp-right-controls"><button class="ytp-settings-button">⚙</button></div>
</div>
<script>
  // 模拟 YouTube 播放器：打开字幕时请求字幕接口（带令牌）
  const player = document.getElementById('movie_player');
  let track = {};
  player.getOption = () => track;
  player.loadModule = () => {};
  player.toggleSubtitles = () => {
    track = { languageCode: 'en' };
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/timedtext?v=vid123&lang=en&pot=TOKEN&c=WEB&fmt=srv3');
    xhr.send();
  };
</script></body></html>`;

const YT_JSON3 = {
  events: [
    { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: 'Welcome to the show.' }] },
    { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: 'Today we talk' }] },
    { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: 'about WebGPU.' }] },
  ],
};

test('PDF: online PDFs open in the Bilingo reader with the translation next to each page', async ({ context, sw }) => {
  await sw.evaluate(async (baseUrl) => {
    await chrome.storage.local.set({
      settings: {
        uiLang: 'en',
        provider: 'openai',
        targetLang: 'zh-CN',
        openai: { baseUrl, apiKey: 'test', model: 'mock' },
        pdf: { autoOpen: true, mode: 'dual' },
      },
    });
  }, `${origin}/v1`);
  // 设置变化后后台注册跳转规则
  await expect
    .poll(() =>
      sw.evaluate(async () => {
        const dnr = (
          globalThis as unknown as { chrome: { declarativeNetRequest: { getDynamicRules(): Promise<unknown[]> } } }
        ).chrome.declarativeNetRequest;
        return (await dnr.getDynamicRules()).length;
      }),
    )
    .toBeGreaterThan(0);

  const page = await context.newPage();
  await page.goto(`${origin}/paper.pdf`);
  await expect(page).toHaveURL(/\/pdf\.html\?DNR:http/);

  // 两个段落各自被同位置的译文覆盖
  const blocks = page.locator('.bl-pane .bl-block');
  await expect(blocks).toHaveCount(2);
  await expect(blocks.first()).toHaveText(fakeTranslate(PDF_PARAGRAPHS[0]!.join(' ')));
  await expect(blocks.nth(1)).toHaveText(fakeTranslate(PDF_PARAGRAPHS[1]![0]!));
  await expect(page.locator('.status')).toContainText('1 pages translated');

  // 译文页在原文页右侧
  const pageBox = (await page.locator('.pdfViewer .page').first().boundingBox())!;
  const paneBox = (await page.locator('.bl-pane').first().boundingBox())!;
  expect(paneBox.x).toBeGreaterThan(pageBox.x + pageBox.width - 1);
  expect(Math.abs(paneBox.width - pageBox.width)).toBeLessThan(2);

  // 只看原文：译文页隐藏
  await page.getByRole('radio', { name: 'Original' }).click();
  await expect(page.locator('.bl-pane').first()).toBeHidden();
  await page.getByRole('radio', { name: 'Side by side' }).click();
  await expect(page.locator('.bl-pane').first()).toBeVisible();

  // 导出译文 PDF：拦截打印，保留打印版式（画布换成图片），再用 Chromium 生成真正的 PDF 检查文字
  await page.evaluate(() => {
    window.print = () => {
      const root = document.getElementById('bl-print')!;
      const copy = root.cloneNode(true) as HTMLElement;
      const canvases = root.querySelectorAll('canvas');
      copy.querySelectorAll('canvas').forEach((c, i) => {
        const img = document.createElement('img');
        img.src = canvases[i]!.toDataURL();
        img.style.cssText = 'display:block;width:100%;height:100%';
        c.replaceWith(img);
      });
      copy.dataset.printed = 'translation';
      document.body.append(copy);
    };
  });
  await page.getByRole('button', { name: 'Download' }).click();
  await page.getByRole('button', { name: /Translated PDF/ }).click();
  const printed = page.locator('[data-printed]');
  await expect(printed).toHaveCount(1);
  await expect(printed.locator('.bl-sheet')).toHaveCount(1);
  await expect(printed.locator('.bl-block')).toHaveText([
    fakeTranslate(PDF_PARAGRAPHS[0]!.join(' ')),
    fakeTranslate(PDF_PARAGRAPHS[1]![0]!),
  ]);
  await page.evaluate(() => document.body.classList.add('bl-printing'));
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const out = await getDocument({ data: new Uint8Array(pdf) }).promise;
  expect(out.numPages).toBe(1);
  const outPage = await out.getPage(1);
  expect(outPage.getViewport({ scale: 1 }).width).toBeCloseTo(612, 0);
  const text = (await outPage.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join('');
  expect(text).toContain('【译】');
});

test('other video sites: bilingual subtitles from HTML5 subtitle tracks', async ({ context, sw }) => {
  await sw.evaluate(async (baseUrl) => {
    await chrome.storage.local.set({
      settings: {
        uiLang: 'en',
        provider: 'openai',
        targetLang: 'zh-CN',
        videoSubtitles: true,
        openai: { baseUrl, apiKey: 'test', model: 'mock' },
      },
    });
  }, `${origin}/v1`);
  const page = await context.newPage();
  await page.goto(`${origin}/video`);
  const overlay = page.locator('#bilingo-video-subs');
  // 字幕片段拼成完整的句子，去掉 WebVTT 标签，并显示译文
  await expect(overlay.locator('.src')).toHaveText('Hello and welcome to the course.');
  // 字幕叠加在视频画面的下部
  await expect(overlay.locator('.src')).toBeVisible();
  const videoBox = (await page.locator('#v').boundingBox())!;
  const lineBox = (await overlay.locator('.src').boundingBox())!;
  expect(lineBox.y).toBeGreaterThan(videoBox.y + videoBox.height / 2);
  expect(lineBox.y + lineBox.height).toBeLessThan(videoBox.y + videoBox.height);
  await expect(overlay.locator('.tr')).toHaveText(fakeTranslate('Hello and welcome to the course.'));
  // 浏览器自己的字幕显示被关掉（轨道改为 hidden），关闭后还原
  const mode = () => page.evaluate(() => (document.getElementById('v') as HTMLVideoElement).textTracks[0]!.mode);
  expect(await mode()).toBe('hidden');

  // 视频上的 Bilingo 按钮：关闭双语字幕
  const button = overlay.locator('.bl-btn');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(300, 150);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(overlay.locator('.src')).toBeHidden();
  await expect.poll(mode).toBe('showing');
  expect(await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings)).toMatchObject({
    videoSubtitles: false,
  });
});

test('YouTube: bilingual subtitles from the player caption request', async ({ sw }) => {
  // 自签名证书，让 www.youtube.com 指向本地 HTTPS 服务器
  const dir = mkdtempSync(path.join(tmpdir(), 'bilingo-yt-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=www.youtube.com',
      '-keyout',
      path.join(dir, 'key.pem'),
      '-out',
      path.join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  const yt = createHttpsServer(
    { key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) },
    (req, res) => {
      const url = new URL(req.url!, 'https://www.youtube.com');
      if (url.pathname === '/watch') return res.writeHead(200, { 'content-type': 'text/html' }).end(YT_PAGE);
      if (url.pathname === '/api/timedtext') {
        // 与真实 YouTube 一致：没有令牌只返回空内容
        if (url.searchParams.get('pot') !== 'TOKEN') return res.writeHead(200).end('');
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(YT_JSON3));
      }
      res.writeHead(404).end();
    },
  );
  await new Promise<void>((r) => yt.listen(0, '127.0.0.1', r));
  const ytPort = (yt.address() as AddressInfo).port;

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--host-resolver-rules=MAP www.youtube.com 127.0.0.1`,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await useMockEngine(worker, { ytSubtitles: true });
    void sw; // 默认 fixture 不使用
    const page = await context.newPage();
    await page.goto(`https://www.youtube.com:${ytPort}/watch?v=vid123`);

    const subs = page.locator('#bilingo-yt-subs');
    await expect(subs.locator('.src')).toHaveText('Welcome to the show.');
    await expect(subs.locator('.tr')).toHaveText('【译】Welcome to the show.');
    // 原生字幕被隐藏，控制栏里有开关按钮
    await expect(page.locator('#native')).toBeHidden();
    await expect(page.locator('.bilingo-yt-btn')).toHaveAttribute('aria-pressed', 'true');

    // 跟随播放进度：两行原字幕被拼成一句
    await page.evaluate(() => (document.querySelector('video')!.currentTime = 4));
    await expect(subs.locator('.src')).toHaveText('Today we talk about WebGPU.');
    await expect(subs.locator('.tr')).toHaveText('【译】Today we talk about WebGPU.');

    // 关闭：叠加层移除，原生字幕恢复
    await page.locator('.bilingo-yt-btn').click();
    await expect(subs).toHaveCount(0);
    await expect(page.locator('#native')).toBeVisible();
  } finally {
    await context.close();
    yt.close();
  }
});

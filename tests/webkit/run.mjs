// 在 macOS 上运行 WebKit 测试页：
//   node tests/webkit/run.mjs webkit <url>   Playwright WebKit：探测 WebGPU 并用本地模型实际翻译
//   node tests/webkit/run.mjs safari <url>   真实 Safari（safaridriver，需先 sudo safaridriver --enable）：探测 WebGPU
// 结果写入 GitHub Actions 的任务摘要。
import { appendFileSync } from 'node:fs';

const [mode, url] = process.argv.slice(2);
const MODEL = process.env.MODEL ?? 'drnfns/Hy-MT2-1.8B-ONNX';
const HOST = process.env.MODEL_HOST ?? 'https://huggingface.co/';
const TEXTS = ['The quick brown fox jumps over the lazy dog.', 'WebGPU brings modern GPU compute to the web.'];

function summary(title, data) {
  const text = `### ${title}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

async function webkit() {
  const { webkit } = await import('playwright');
  const browser = await webkit.launch();
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  await page.goto(url);
  await page.waitForFunction(() => typeof window.probe === 'function');
  const probe = await page.evaluate(() => window.probe());
  summary(`Playwright WebKit ${browser.version()}: WebGPU`, probe);
  if (!probe.adapter) throw new Error('No WebGPU adapter in Playwright WebKit');
  page.setDefaultTimeout(30 * 60_000);
  const res = await page.evaluate(([m, h, t]) => window.translate(m, h, t), [MODEL, HOST, TEXTS]);
  summary(`Playwright WebKit: local model ${MODEL}`, { input: TEXTS, ...res });
  await browser.close();
  if (res.result.length !== TEXTS.length || !res.result.every((t) => /[一-鿿]/.test(t))) {
    throw new Error('Local model did not produce Chinese translations');
  }
}

async function safari() {
  const base = 'http://127.0.0.1:4444';
  const call = async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(json));
    return json.value;
  };
  const session = await call('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
  const sid = session.sessionId;
  try {
    await call('POST', `/session/${sid}/url`, { url });
    await new Promise((r) => setTimeout(r, 2000));
    const probe = await call('POST', `/session/${sid}/execute/async`, {
      script:
        'const done = arguments[arguments.length - 1]; window.probe().then(done, (e) => done({ error: String(e) }));',
      args: [],
    });
    summary(`Safari ${session.capabilities.browserVersion}: WebGPU`, probe);
  } finally {
    await call('DELETE', `/session/${sid}`).catch(() => {});
  }
}

await (mode === 'safari' ? safari() : webkit());

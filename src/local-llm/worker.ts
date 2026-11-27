// 在 Web Worker 中用 Transformers.js + WebGPU 运行 Hy-MT2 翻译模型
import { m, setUiLang } from '@/shared/i18n';
import { env, pipeline, type TextGenerationPipeline } from '@huggingface/transformers';
import { buildMessages, cleanOutput, maxNewTokens } from './prompt';
import type { LocalModelConfig, LocalStatus, WorkerRequest, WorkerResponse } from './protocol';
import { createResumableFetch } from './resumable-fetch';

// 扩展禁止加载远程代码：ONNX Runtime 的 wasm 随扩展打包在 /ort/ 下
env.backends.onnx.wasm!.wasmPaths = '/ort/';
env.allowLocalModels = false;
// 大文件分块下载、断点续传
env.fetch = createResumableFetch();

const post = (msg: WorkerResponse) => self.postMessage(msg);
const setStatus = (status: LocalStatus) => post({ type: 'status', status });

let current: { key: string; pipe: Promise<TextGenerationPipeline> } | null = null;
// 同一时刻只跑一个生成任务（GPU 串行）
let chain: Promise<unknown> = Promise.resolve();

/** 浏览器的 GPU 诊断页地址 */
function gpuPage(): string {
  return navigator.userAgent.includes('Edg/') ? 'edge://gpu' : 'chrome://gpu';
}

async function pickDevice(): Promise<{ dtype: 'q4f16' | 'q4'; adapter: string }> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) {
    throw new Error(m.err_no_webgpu());
  }
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    // 常见原因：GPU 进程多次崩溃后浏览器在本次运行期间禁用了 WebGPU，或关闭了硬件加速、显卡在黑名单中
    throw new Error(m.err_webgpu_disabled({ page: gpuPage() }));
  }
  if ((adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean }).isFallbackAdapter) {
    throw new Error(m.err_webgpu_software({ page: gpuPage() }));
  }
  const name = [adapter.info.vendor, adapter.info.architecture].filter(Boolean).join(' ');
  return { dtype: adapter.features.has('shader-f16') ? 'q4f16' : 'q4', adapter: name || 'unknown' };
}

function load(config: LocalModelConfig): Promise<TextGenerationPipeline> {
  const key = `${config.host}|${config.model}|${config.dtype ?? 'auto'}`;
  if (current?.key === key) return current.pipe;
  // 切换模型：先释放旧模型占用的显存
  if (current) {
    const old = current.pipe;
    current = null;
    void old.then((p) => p.dispose()).catch(() => undefined);
  }
  env.remoteHost = config.host.endsWith('/') ? config.host : `${config.host}/`;

  const files = new Map<string, { loaded: number; total: number }>();
  const started = new Set<string>();
  const pipe = (async () => {
    const device = await pickDevice();
    const dtype = config.dtype ?? device.dtype;
    const adapter = device.adapter;
    setStatus({ state: 'downloading', progress: 0, loaded: 0, total: 0, waiting: 0 });
    const p = await pipeline('text-generation', config.model, {
      dtype,
      device: 'webgpu',
      progress_callback: (e) => {
        if (e.status === 'download') started.add(e.file);
        else if (e.status === 'progress') files.set(e.file, { loaded: e.loaded, total: e.total });
        else if (e.status === 'done') started.delete(e.file);
        else return;
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        const waiting = [...started].filter((f) => !files.has(f)).length;
        if (e.status === 'done' && started.size === 0 && total > 0 && loaded >= total) {
          // 所有文件都已就位，接下来是把模型上传到显卡、编译着色器
          setStatus({ state: 'loading' });
          return;
        }
        setStatus({ state: 'downloading', progress: total ? loaded / total : 0, loaded, total, waiting });
      },
    });
    setStatus({ state: 'ready', dtype, adapter });
    return p;
  })();
  current = { key, pipe };
  pipe.catch((e: unknown) => {
    if (current?.pipe === pipe) current = null;
    setStatus({ state: 'error', message: (e as Error).message || String(e) });
  });
  return pipe;
}

async function translate(
  config: LocalModelConfig,
  texts: string[],
  targetLang: string,
  sourceLangs?: string[],
): Promise<string[]> {
  const pending = load(config);
  const pipe = await pending;
  const out: string[] = [];
  try {
    for (const [i, text] of texts.entries()) {
      const messages = buildMessages(config.format, text, targetLang, sourceLangs?.[i]);
      const result = await pipe(messages as Parameters<TextGenerationPipeline>[0], {
        max_new_tokens: maxNewTokens(text),
        do_sample: false,
        repetition_penalty: 1.05,
      });
      const generated = (result[0] as { generated_text: { role: string; content: string }[] }).generated_text;
      out.push(cleanOutput(generated.at(-1)?.content ?? ''));
    }
  } catch (e) {
    // 推理失败多半是 GPU 设备丢失（GPU 进程崩溃 / 驱动重置），丢弃旧模型，下次请求时从缓存重新加载
    if (current?.pipe === pending) current = null;
    pipe.dispose().catch(() => undefined);
    setStatus({
      state: 'error',
      message: m.err_inference({ msg: (e as Error).message }),
    });
    throw e;
  }
  return out;
}

self.addEventListener('message', (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  const run = async () => {
    setUiLang(req.config.locale);
    try {
      if (req.type === 'load') {
        await load(req.config);
        post({ id: req.id, type: 'result' });
      } else {
        post({
          id: req.id,
          type: 'result',
          result: await translate(req.config, req.texts, req.targetLang, req.sourceLangs),
        });
      }
    } catch (e) {
      post({ id: req.id, type: 'error', message: (e as Error).message || String(e) });
    }
  };
  // load 不排队（便于并行下载时响应查询），translate 串行执行
  if (req.type === 'load') void run();
  else chain = chain.then(run);
});

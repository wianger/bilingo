// 版面分析模型的 Worker：下载（断点续传、缓存、校验哈希）→ ONNX Runtime（WebGPU，不可用时 WebAssembly）→ 推理
import * as ort from 'onnxruntime-web/webgpu';
import { createResumableFetch } from '@/local-llm/resumable-fetch';
import { LAYOUT_MODEL } from './layout-model';

// 扩展禁止加载远程代码：ONNX Runtime 的 wasm 随扩展打包在 /ort/ 下
ort.env.wasm.wasmPaths = '/ort/';

export type LayoutRequest =
  { id: number; type: 'init'; url: string } | { id: number; type: 'detect'; image: Float32Array };

export type LayoutResponse =
  | { id: number; type: 'ok'; rows?: Float32Array; count?: number; backend?: string }
  | { id: number; type: 'error'; message: string }
  | { type: 'progress'; loaded: number; total: number };

const MODEL_CACHE = 'bilingo-models';
const post = (msg: LayoutResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

let session: Promise<{ s: ort.InferenceSession; backend: string }> | null = null;
let chain: Promise<unknown> = Promise.resolve();

async function hex(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 下载模型：已缓存则直接读取；否则分块下载（可断点续传），校验哈希后写入缓存 */
async function download(url: string): Promise<ArrayBuffer> {
  const cache = await caches.open(MODEL_CACHE);
  const key = `https://bilingo.local/${LAYOUT_MODEL.file}?${LAYOUT_MODEL.sha256}`;
  const hit = await cache.match(key);
  if (hit) return hit.arrayBuffer();
  const res = await createResumableFetch()(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || LAYOUT_MODEL.bytes;
  const parts: Uint8Array[] = [];
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    post({ type: 'progress', loaded, total });
  }
  const buf = await new Blob(parts as BlobPart[]).arrayBuffer();
  if ((await hex(buf)) !== LAYOUT_MODEL.sha256) throw new Error('Layout model checksum mismatch');
  await cache.put(key, new Response(buf));
  return buf;
}

async function createSession(url: string) {
  const model = new Uint8Array(await download(url));
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (gpu && (await gpu.requestAdapter().catch(() => null))) {
    try {
      return { s: await ort.InferenceSession.create(model, { executionProviders: ['webgpu'] }), backend: 'webgpu' };
    } catch {
      // 退回 WebAssembly
    }
  }
  return { s: await ort.InferenceSession.create(model, { executionProviders: ['wasm'] }), backend: 'wasm' };
}

async function detect(image: Float32Array) {
  const { s } = await session!;
  const n = LAYOUT_MODEL.size;
  const out = await s.run({
    image: new ort.Tensor('float32', image, [1, 3, n, n]),
    im_shape: new ort.Tensor('float32', new Float32Array([n, n]), [1, 2]),
    scale_factor: new ort.Tensor('float32', new Float32Array([1, 1]), [1, 2]),
  });
  const [boxes, count] = s.outputNames.map((k) => out[k]!);
  return { rows: boxes!.data as Float32Array, count: Number((count!.data as Int32Array)[0] ?? boxes!.dims[0]) };
}

self.addEventListener('message', (ev: MessageEvent<LayoutRequest>) => {
  const req = ev.data;
  const run = async () => {
    try {
      if (req.type === 'init') {
        session ??= createSession(req.url);
        session.catch(() => (session = null));
        post({ id: req.id, type: 'ok', backend: (await session).backend });
      } else {
        const { rows, count } = await detect(req.image);
        const copy = rows.slice(0, count * 7);
        post({ id: req.id, type: 'ok', rows: copy, count }, [copy.buffer]);
      }
    } catch (e) {
      post({ id: req.id, type: 'error', message: (e as Error).message || String(e) });
    }
  };
  // GPU 推理串行执行
  chain = chain.then(run);
});

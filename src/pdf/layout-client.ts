// 阅读器页面一侧：把 PDF 页面渲染成 800×800 的图像交给版面分析 Worker，取回区域
import type { PDFPageProxy } from 'pdfjs-dist';
import { decodeRegions, LAYOUT_MODEL, layoutModelUrl, type Region } from './layout-model';
import type { LayoutRequest, LayoutResponse } from './layout-worker';

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type Ok = Extract<LayoutResponse, { type: 'ok' }>;

export class LayoutDetector {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Ok) => void; reject: (e: Error) => void }>();
  private ready: Promise<string> | null = null;
  /** 模型下载进度 */
  onProgress?: (loaded: number, total: number) => void;

  private call(req: WithoutId<LayoutRequest>, transfer: Transferable[] = []): Promise<Ok> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' });
      this.worker.addEventListener('message', (ev: MessageEvent<LayoutResponse>) => {
        const msg = ev.data;
        if (msg.type === 'progress') return this.onProgress?.(msg.loaded, msg.total);
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.type === 'ok') p?.resolve(msg);
        else p?.reject(new Error(msg.message));
      });
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...req, id }, transfer);
    });
  }

  /** 下载并加载模型；返回使用的后端（webgpu / wasm） */
  init(host: string): Promise<string> {
    this.ready ??= this.call({ type: 'init', url: layoutModelUrl(host) }).then((r) => r.backend ?? '');
    this.ready.catch(() => (this.ready = null));
    return this.ready;
  }

  async detect(page: PDFPageProxy): Promise<Region[]> {
    const n = LAYOUT_MODEL.size;
    const vp = page.getViewport({ scale: 1 });
    const canvas = new OffscreenCanvas(n, n);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, n, n);
    // 拉伸到 800×800（模型训练时就是这样预处理的）
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport: vp,
      transform: [n / vp.width, 0, 0, n / vp.height, 0, 0],
    }).promise;
    const { data } = ctx.getImageData(0, 0, n, n);
    // RGBA → CHW，除以 255（不做均值方差归一化）
    const image = new Float32Array(3 * n * n);
    for (let i = 0, plane = n * n; i < plane; i++) {
      image[i] = data[i * 4]! / 255;
      image[plane + i] = data[i * 4 + 1]! / 255;
      image[2 * plane + i] = data[i * 4 + 2]! / 255;
    }
    const res = await this.call({ type: 'detect', image }, [image.buffer]);
    return decodeRegions(res.rows!, res.count ?? 0, vp.width, vp.height);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const p of this.pending.values()) p.reject(new Error('disposed'));
    this.pending.clear();
  }
}

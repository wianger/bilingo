// Bilingo PDF 阅读器：pdf.js 的 PDFViewer 负责原文（渲染、文字层、链接、按需加载），
// 每一页右侧挂一张"译文页"：复制原页面的画面，再在每个段落的位置盖上同底色的方块写入译文。
// 图片、公式、表格保持原样，只有可翻译的段落被替换。这是 BabelDOC / PDFMathTranslate
// "保留排版"思路在浏览器里的轻量实现（不重新生成 PDF）。
import 'pdfjs-dist/web/pdf_viewer.css';
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist';
import { EventBus, LinkTarget, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { detectLanguage } from '@/shared/builtin';
import { m } from '@/shared/i18n';
import { sameLanguage } from '@/shared/langs';
import { batchLimits, type PdfMode, type Settings } from '@/shared/settings';
import { translateBatch } from '@/shared/translate-client';
import { extractBlocks, type Block, type TextItemLike } from './layout';
import { LayoutDetector } from './layout-client';
import type { Region } from './layout-model';

GlobalWorkerOptions.workerSrc = workerUrl;

/** 原文页和译文页之间的间距 */
const GAP = 16;
/** 译文最多缩小到原字号的这个比例，再放不下就让方块向下延伸 */
const MIN_FIT = 0.6;
/** 提前翻译的页数 */
const AHEAD = 2;
/** 导出时页面画面的分辨率（与 pdf.js 打印相同：150 DPI） */
const PRINT_SCALE = 150 / 72;

type PageState = 'idle' | 'loading' | 'done' | 'error';

interface PageData {
  state: PageState;
  blocks: Block[];
  /** 与 blocks 一一对应；undefined 表示不需要替换（已是目标语言、翻译为空） */
  tr: (string | undefined)[];
  /** 译文缩放比例（与页面缩放无关，计算一次即可） */
  fit: number[];
  error?: string;
  /** 页面宽度（PDF 单位），用于换算画布像素 */
  width: number;
}

/** AI 版面分析的状态 */
export type LayoutStatus =
  | { state: 'off' }
  | { state: 'downloading'; progress: number }
  | { state: 'ready'; backend: string }
  | { state: 'error'; message: string };

export interface ViewerStatus {
  layout: LayoutStatus;
  pages: number;
  page: number;
  scale: number;
  /** 已翻译 / 正在翻译 / 出错的页数 */
  done: number;
  loading: number;
  errors: number;
  lastError?: string;
}

export type ZoomValue = 'auto' | number;

const pdfjsAsset = (dir: string) => browser.runtime.getURL(`/pdfjs/${dir}/` as '/pdf.html');

export class BilingualPdfViewer {
  readonly eventBus = new EventBus();
  private readonly linkService: PDFLinkService;
  private readonly viewer: PDFViewer;
  private doc: PDFDocumentProxy | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private pages = new Map<number, PageData>();
  /** 正在进行的翻译任务（导出时等待） */
  private jobs = new Map<number, Promise<void>>();
  private panes = new Map<number, HTMLElement>();
  private visible = new Set<number>();
  private observer: IntersectionObserver;
  private generation = 0;
  private zoom: ZoomValue = 'auto';
  private _mode: PdfMode;
  private detector: LayoutDetector | null = null;
  private layoutStatus: LayoutStatus = { state: 'off' };
  onStatus?: (s: ViewerStatus) => void;

  constructor(
    private readonly container: HTMLDivElement,
    private readonly getSettings: () => Settings,
  ) {
    this._mode = getSettings().pdf.mode;
    this.linkService = new PDFLinkService({ eventBus: this.eventBus, externalLinkTarget: LinkTarget.BLANK });
    this.viewer = new PDFViewer({
      container,
      viewer: container.firstElementChild as HTMLDivElement,
      eventBus: this.eventBus,
      linkService: this.linkService,
    });
    this.linkService.setViewer(this.viewer);
    this.container.classList.add(`mode-${this._mode}`);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.pageNumber);
          if (e.isIntersecting) this.visible.add(n);
          else this.visible.delete(n);
        }
        this.schedule();
      },
      { root: container, rootMargin: '50% 0px' },
    );

    this.eventBus.on('pagesinit', () => {
      this.applyZoom();
      for (const div of container.querySelectorAll<HTMLElement>('.page')) this.observer.observe(div);
      this.emit();
    });
    this.eventBus.on('pagerendered', (e: { pageNumber: number; isDetailView?: boolean }) => {
      if (!e.isDetailView) this.paint(e.pageNumber);
    });
    this.eventBus.on('pagechanging', () => this.emit());
    this.eventBus.on('scalechanging', () => {
      this.layout();
      this.emit();
    });
    new ResizeObserver(() => {
      if (this.zoom === 'auto') this.applyZoom();
      else this.layout();
    }).observe(container);

    // 鼠标悬停：原文段落和译文段落同时高亮
    container.addEventListener('pointermove', (e) => this.hover(e));
    container.addEventListener('pointerleave', () => this.highlight(null));
  }

  async open(source: { url: string } | { data: ArrayBuffer }): Promise<PDFDocumentProxy> {
    this.close();
    const task = getDocument({
      ...('url' in source ? { url: source.url, withCredentials: true } : { data: source.data }),
      cMapUrl: pdfjsAsset('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: pdfjsAsset('standard_fonts'),
      wasmUrl: pdfjsAsset('wasm'),
      iccUrl: pdfjsAsset('iccs'),
    });
    this.task = task;
    task.onPassword = (update: (pw: string) => void) => {
      const pw = prompt(m.pdf_password());
      if (pw !== null) update(pw);
    };
    const doc = await task.promise;
    this.doc = doc;
    this.viewer.setDocument(doc);
    this.linkService.setDocument(doc);
    return doc;
  }

  close() {
    this.generation++;
    this.observer.disconnect();
    this.pages.clear();
    this.panes.clear();
    this.visible.clear();
    if (this.doc) {
      this.viewer.setDocument(null);
      this.linkService.setDocument(null);
      this.doc = null;
    }
    void this.task?.destroy();
    this.task = null;
  }

  get document() {
    return this.doc;
  }

  get mode(): PdfMode {
    return this._mode;
  }

  set mode(mode: PdfMode) {
    if (mode === this._mode) return;
    this.container.classList.replace(`mode-${this._mode}`, `mode-${mode}`);
    this._mode = mode;
    this.applyZoom();
    this.schedule();
  }

  setZoom(z: ZoomValue) {
    this.zoom = z;
    this.applyZoom();
  }

  zoomBy(step: number) {
    const cur = this.viewer.currentScale;
    const next = Math.min(4, Math.max(0.25, Math.round((cur + step) * 10) / 10));
    this.setZoom(next);
  }

  goTo(page: number) {
    if (this.doc) this.viewer.currentPageNumber = Math.min(this.doc.numPages, Math.max(1, page));
  }

  /** 翻译设置（服务、目标语言、版面分析）变了：丢弃已有译文重新翻译 */
  retranslate() {
    this.generation++;
    if (this.layoutStatus.state === 'error') this.layoutStatus = { state: 'off' };
    this.pages.clear();
    for (const [n] of this.panes) this.paint(n);
    this.schedule();
    this.emit();
  }

  /** 重试翻译失败的页面 */
  retryFailed() {
    for (const [n, p] of this.pages) if (p.state === 'error') this.pages.delete(n);
    this.schedule();
  }

  private applyZoom() {
    if (!this.doc || !this.viewer.pagesCount) return;
    if (this.zoom !== 'auto') {
      this.viewer.currentScale = this.zoom;
    } else if (this._mode === 'dual') {
      // 并排时让两页一起放进窗口
      const pv = this.viewer.getPageView(this.viewer.currentPageNumber - 1) as { width: number; scale: number };
      const pageWidth = pv.width / pv.scale; // 缩放为 1 时的 CSS 宽度
      const fit = (this.container.clientWidth - GAP * 3 - 20) / (pageWidth * 2);
      this.viewer.currentScale = Math.min(1.6, Math.max(0.3, fit));
    } else {
      this.viewer.currentScaleValue = 'auto';
    }
    this.layout();
  }

  /** 并排模式：把原文页向左移，让"原文 + 译文"整体居中 */
  private layout() {
    if (!this.viewer.pagesCount) return;
    const pv = this.viewer.getPageView(this.viewer.currentPageNumber - 1) as { width: number };
    const left = Math.max(GAP, (this.container.clientWidth - (pv.width * 2 + GAP)) / 2);
    this.container.style.setProperty('--bl-left', `${left}px`);
    this.container.style.setProperty('--bl-gap', `${GAP}px`);
  }

  private emit() {
    let done = 0;
    let loading = 0;
    let errors = 0;
    let lastError: string | undefined;
    for (const p of this.pages.values()) {
      if (p.state === 'done') done++;
      else if (p.state === 'loading') loading++;
      else if (p.state === 'error') {
        errors++;
        lastError = p.error;
      }
    }
    this.onStatus?.({
      layout: this.layoutStatus,
      pages: this.doc?.numPages ?? 0,
      page: this.viewer.currentPageNumber,
      scale: this.viewer.currentScale,
      done,
      loading,
      errors,
      lastError,
    });
  }

  /** 翻译可见的页面和后面几页 */
  private schedule() {
    if (!this.doc || this._mode === 'original' || !this.visible.size) return;
    const max = Math.max(...this.visible);
    const want = [...this.visible, ...Array.from({ length: AHEAD }, (_, i) => max + i + 1)];
    for (const n of want) {
      if (n <= this.doc.numPages && !this.pages.has(n)) void this.translatePage(n);
    }
  }

  private translatePage(n: number): Promise<void> {
    const job = this.runTranslatePage(n).finally(() => {
      if (this.jobs.get(n) === job) this.jobs.delete(n);
    });
    this.jobs.set(n, job);
    return job;
  }

  private async runTranslatePage(n: number) {
    const doc = this.doc!;
    const gen = this.generation;
    const data: PageData = { state: 'loading', blocks: [], tr: [], fit: [], width: 0 };
    this.pages.set(n, data);
    this.emit();
    this.paint(n);
    try {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      if (gen !== this.generation) return;
      data.width = vp.width;
      const regions = await this.detectRegions(page);
      if (gen !== this.generation) return;
      data.blocks = extractBlocks(content.items as TextItemLike[], vp.transform, regions);
      data.tr = await this.translateBlocks(data.blocks.map((b) => b.text));
      if (gen !== this.generation) return;
      data.state = 'done';
    } catch (e) {
      if (gen !== this.generation) return;
      data.state = 'error';
      data.error = (e as Error).message || String(e);
    }
    this.paint(n);
    this.emit();
  }

  /** AI 版面分析（开启时）：失败时退回几何规则，并在状态栏提示 */
  private async detectRegions(page: Parameters<LayoutDetector['detect']>[0]): Promise<Region[] | undefined> {
    const s = this.getSettings();
    if (!s.pdf.aiLayout) {
      this.detector?.dispose();
      this.detector = null;
      this.layoutStatus = { state: 'off' };
      return undefined;
    }
    if (this.layoutStatus.state === 'error') return undefined;
    if (!this.detector) {
      this.detector = new LayoutDetector();
      this.detector.onProgress = (loaded, total) => {
        this.layoutStatus = { state: 'downloading', progress: total ? loaded / total : 0 };
        this.emit();
      };
    }
    try {
      const backend = await this.detector.init(s.local.host);
      if (this.layoutStatus.state !== 'ready') {
        this.layoutStatus = { state: 'ready', backend };
        this.emit();
      }
      return await this.detector.detect(page);
    } catch (e) {
      this.layoutStatus = { state: 'error', message: (e as Error).message || String(e) };
      this.emit();
      return undefined;
    }
  }

  private async translateBlocks(texts: string[]): Promise<(string | undefined)[]> {
    const s = this.getSettings();
    const out: (string | undefined)[] = texts.map(() => undefined);
    // 非内置翻译：先用浏览器内置的语言检测跳过已是目标语言的段落（内置翻译会自行检测）
    let todo = texts.map((_, i) => i);
    if (s.provider !== 'builtin') {
      const langs = await Promise.all(texts.map((t) => detectLanguage(t)));
      todo = todo.filter((i) => !(langs[i] && sameLanguage(langs[i], s.targetLang)));
    }
    const { maxChars, maxItems } = batchLimits(s);
    const batches: number[][] = [];
    let cur: number[] = [];
    let chars = 0;
    for (const i of todo) {
      const len = texts[i]!.length;
      if (cur.length && (chars + len > maxChars || cur.length >= maxItems)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(i);
      chars += len;
    }
    if (cur.length) batches.push(cur);
    await Promise.all(
      batches.map(async (b) => {
        const res = await translateBatch(
          b.map((i) => texts[i]!),
          s,
        );
        b.forEach((i, j) => {
          const t = res[j]?.trim();
          if (t && t !== texts[i]) out[i] = t;
        });
      }),
    );
    return out;
  }

  /** 生成 / 更新第 n 页的译文页（页面渲染完成、译文到达时调用） */
  private paint(n: number) {
    const pv = this.viewer.getPageView(n - 1) as
      { div: HTMLDivElement; canvas?: HTMLCanvasElement | null; renderingState: number } | undefined;
    const canvas = pv?.canvas;
    if (!pv || !canvas || !canvas.width) return;

    let pane = this.panes.get(n);
    // pdf.js 重置页面（缩放、移出缓冲区）时会移除它不认识的子元素，需要重新挂上
    if (!pane || pane.parentElement !== pv.div) {
      pane = document.createElement('div');
      pane.className = 'bl-pane';
      pane.append(document.createElement('canvas'));
      pv.div.append(pane);
      this.panes.set(n, pane);
    }
    const copy = pane.firstElementChild as HTMLCanvasElement;
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(canvas, 0, 0);
    for (const el of pane.querySelectorAll('.bl-block, .bl-badge')) el.remove();

    const data = this.pages.get(n);
    if (!data || data.state === 'loading') {
      pane.append(badge('loading'));
      return;
    }
    if (data.state === 'error') {
      pane.append(badge('error', data.error));
      return;
    }
    this.fit(data, drawBlocks(pane, ctx, data, this.getSettings().targetLang));
  }

  /** 译文比原文长时缩小字号，直到放进原段落的方框（最多缩到 MIN_FIT，仍放不下就让方框向下延伸） */
  private fit(data: PageData, els: HTMLElement[]) {
    const idx = (el: HTMLElement) => Number(el.dataset.i);
    const need: HTMLElement[] = [];
    for (const el of els) {
      const f = data.fit[idx(el)];
      if (f === undefined) need.push(el);
      else el.style.setProperty('--bl-fit', String(f));
    }
    if (!need.length) return;
    // 测量时把高度固定为原段落的高度
    for (const el of need) {
      el.style.height = el.style.minHeight;
      el.style.setProperty('--bl-fit', '1');
    }
    // 没有参与排版（未挂到文档、所在页隐藏）就无法测量：先按原字号显示，下次绘制时再算
    if (!need[0]!.isConnected || need[0]!.clientHeight === 0) {
      for (const el of need) el.style.removeProperty('height');
      return;
    }
    const fits = (el: HTMLElement) => el.scrollHeight <= el.clientHeight + 1;
    const over = need.filter((el) => !fits(el));
    const lo = new Map(over.map((el) => [el, MIN_FIT]));
    const hi = new Map(over.map((el) => [el, 1]));
    // 二分查找；每一轮先统一写入、再统一读取，整轮只触发一次排版
    for (let round = 0; round < 5; round++) {
      for (const el of over) el.style.setProperty('--bl-fit', String((lo.get(el)! + hi.get(el)!) / 2));
      for (const el of over) {
        const mid = (lo.get(el)! + hi.get(el)!) / 2;
        if (fits(el)) lo.set(el, mid);
        else hi.set(el, mid);
      }
    }
    for (const el of need) {
      const f = lo.get(el) ?? 1;
      data.fit[idx(el)] = f;
      el.style.setProperty('--bl-fit', String(f));
      el.style.removeProperty('height');
    }
  }

  /**
   * 导出翻译后的 PDF：翻译全部页面，生成打印版式（页面画面 + 可选中的译文文字），
   * 调用浏览器的打印，在打印对话框里选"另存为 PDF"。字体由浏览器嵌入，任何语言都能正确显示。
   * pdf.js 自己的打印同样是把页面栅格化（150 DPI），这里用相同的分辨率。
   */
  async exportPdf(layout: 'translation' | 'dual', onProgress: (done: number, total: number) => void) {
    const doc = this.doc;
    if (!doc) return;
    const total = doc.numPages;
    let done = 0;
    // 1. 翻译所有页面（最多 2 页并行，服务的并发由后台控制）
    const queue = Array.from({ length: total }, (_, i) => i + 1);
    const worker = async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        const cur = this.pages.get(n);
        if (this.jobs.has(n)) await this.jobs.get(n);
        else if (!cur || cur.state === 'error') await this.translatePage(n);
        onProgress(++done, total * 2);
      }
    };
    await Promise.all([worker(), worker()]);

    // 2. 渲染打印版式
    const root = document.createElement('div');
    root.id = 'bl-print';
    root.className = `bl-print-${layout}`;
    document.body.append(root);
    let sheetW = 0;
    let sheetH = 0;
    try {
      for (let n = 1; n <= total; n++) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: PRINT_SCALE });
        const unit = page.getViewport({ scale: 1 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        await page.render({ canvas, viewport: vp }).promise;
        const sheet = document.createElement('div');
        sheet.className = 'bl-sheet';
        // 先放进文档再画译文：缩放字号要测量排版结果
        root.append(sheet);
        const makePage = () => {
          const el = document.createElement('div');
          el.className = 'bl-sheet-page';
          el.style.width = `${unit.width}pt`;
          el.style.height = `${unit.height}pt`;
          sheet.append(el);
          return el;
        };
        if (layout === 'dual') {
          const original = makePage();
          const img = canvas.cloneNode() as HTMLCanvasElement;
          img.getContext('2d')!.drawImage(canvas, 0, 0);
          original.append(img);
        }
        const translated = makePage();
        translated.append(canvas);
        const data = this.pages.get(n);
        if (data?.state === 'done') {
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          this.fit(data, drawBlocks(translated, ctx, data, this.getSettings().targetLang));
        }
        sheetW = Math.max(sheetW, unit.width * (layout === 'dual' ? 2 : 1));
        sheetH = Math.max(sheetH, unit.height);
        page.cleanup();
        onProgress(++done, total * 2);
      }
      const style = document.createElement('style');
      style.textContent = `@page { size: ${sheetW}pt ${sheetH}pt; margin: 0; }`;
      root.append(style);
      document.body.classList.add('bl-printing');
      window.print();
    } finally {
      document.body.classList.remove('bl-printing');
      root.remove();
    }
  }

  private highlighted: Element[] = [];

  private hover(e: PointerEvent) {
    const page = (e.target as Element).closest<HTMLElement>('.page');
    const n = Number(page?.dataset.pageNumber);
    const data = this.pages.get(n);
    if (!page || !data || data.state !== 'done') return this.highlight(null);
    const pane = this.panes.get(n);
    // 指针所在的页面坐标（原文页或译文页，二者大小相同），换算为 PDF 单位
    const onPane = pane?.contains(e.target as Node) ?? false;
    const box = (onPane ? pane! : page).getBoundingClientRect();
    const unit = data.width / box.width;
    const x = (e.clientX - box.left) * unit;
    const y = (e.clientY - box.top) * unit;
    const i = data.blocks.findIndex((b, j) => data.tr[j] && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    this.highlight(i >= 0 ? { n, i, page, pane } : null);
  }

  private highlight(t: { n: number; i: number; page: HTMLElement; pane?: HTMLElement } | null) {
    for (const el of this.highlighted) el.classList.remove('bl-hover');
    this.highlighted = [];
    for (const el of this.container.querySelectorAll('.bl-src-hl')) el.remove();
    if (!t) return;
    const b = this.pages.get(t.n)!.blocks[t.i]!;
    const el = t.pane?.querySelector(`.bl-block[data-i="${t.i}"]`);
    if (el) {
      el.classList.add('bl-hover');
      this.highlighted.push(el);
    }
    if (this._mode !== 'dual') return;
    const hl = document.createElement('div');
    hl.className = 'bl-src-hl';
    hl.style.cssText = [
      `left: calc(var(--total-scale-factor) * ${b.x - 2}px)`,
      `top: calc(var(--total-scale-factor) * ${b.y - 2}px)`,
      `width: calc(var(--total-scale-factor) * ${b.w + 4}px)`,
      `height: calc(var(--total-scale-factor) * ${b.h + 4}px)`,
    ].join(';');
    t.page.append(hl);
  }
}

/**
 * 在译文页上画出译文段落：每个段落一个方块，底色和文字颜色取自原页面画面，盖住原文。
 * 位置、字号都写成 PDF 单位 × --total-scale-factor（pdf.js 的缩放变量；打印版式里设为 pt→px 的换算）。
 */
function drawBlocks(
  container: HTMLElement,
  ctx: CanvasRenderingContext2D,
  data: PageData,
  lang: string,
): HTMLElement[] {
  const k = ctx.canvas.width / data.width; // PDF 单位 → 画布像素
  const blocks: HTMLElement[] = [];
  data.blocks.forEach((b, i) => {
    const tr = data.tr[i];
    if (!tr) return;
    const bg = sampleColor(ctx, (b.x - 2) * k, (b.y + b.h / 2) * k);
    const el = document.createElement('div');
    el.className = 'bl-block';
    el.dataset.i = String(i);
    el.lang = lang;
    el.textContent = tr; // 纯文本，杜绝 XSS
    el.style.cssText = [
      `left: calc(var(--total-scale-factor) * ${b.x - 1}px)`,
      `top: calc(var(--total-scale-factor) * ${b.y - 1}px)`,
      `width: calc(var(--total-scale-factor) * ${b.w + 2}px)`,
      `min-height: calc(var(--total-scale-factor) * ${b.h + 2}px)`,
      `--bl-size: ${b.size}px`,
      `background: rgb(${bg.join(' ')})`,
      `color: ${textColor(ctx, b, k, bg)}`,
    ].join(';');
    container.append(el);
    blocks.push(el);
  });
  return blocks;
}

function badge(kind: 'loading' | 'error', text?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `bl-badge ${kind}`;
  el.textContent = text ?? m.pdf_translating();
  return el;
}

/** 读取画布上一个像素的颜色，作为覆盖原文的方块底色 */
function sampleColor(ctx: CanvasRenderingContext2D, x: number, y: number): [number, number, number] {
  const px = Math.max(0, Math.min(ctx.canvas.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(ctx.canvas.height - 1, Math.round(y)));
  const d = ctx.getImageData(px, py, 1, 1).data;
  // 透明（页面没有底色）按白色处理
  if (d[3]! < 10) return [255, 255, 255];
  return [d[0]!, d[1]!, d[2]!];
}

/**
 * 原文的文字颜色：在第一行文字中部取一行像素，找与底色差别最大的颜色（彩色标题、链接保持原色）；
 * 找不到明显的文字颜色时按底色深浅选黑或白
 */
function textColor(ctx: CanvasRenderingContext2D, b: Block, k: number, bg: [number, number, number]): string {
  const x = Math.max(0, Math.round(b.x * k));
  const y = Math.round((b.y + 0.6 * b.size) * k);
  const w = Math.min(Math.round(b.w * k), ctx.canvas.width - x);
  if (w > 0 && y >= 0 && y < ctx.canvas.height) {
    const d = ctx.getImageData(x, y, w, 1).data;
    let best = 0;
    let color: number[] = [];
    for (let i = 0; i < d.length; i += 4) {
      const dist = Math.abs(d[i]! - bg[0]) + Math.abs(d[i + 1]! - bg[1]) + Math.abs(d[i + 2]! - bg[2]);
      if (dist > best) {
        best = dist;
        color = [d[i]!, d[i + 1]!, d[i + 2]!];
      }
    }
    // 抗锯齿边缘的颜色偏浅，只采用足够深（与底色差别足够大）的颜色；近黑统一用 #111
    if (best > 300) {
      const saturated = Math.max(...color) - Math.min(...color) > 60;
      if (saturated) return `rgb(${color.join(' ')})`;
    }
  }
  return luminance(bg) < 0.45 ? '#f5f5f5' : '#111';
}

function luminance([r, g, b]: [number, number, number]): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

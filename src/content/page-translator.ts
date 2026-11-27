// 页面翻译调度：段落进入视口 → 语言检测 → 分批翻译 → 插入译文；同时监听动态内容
import { detectLanguage, translateBuiltin } from '@/shared/builtin';
import { sameLanguage } from '@/shared/langs';
import { sendMessage } from '@/shared/messaging';
import { detectMainContent, type MainContent } from './main-content';
import { batchLimits, type Settings } from '@/shared/settings';
import {
  collectSegments,
  getText,
  isOwnNode,
  isVisuallyHidden,
  preferInline,
  SKIP_CONTEXT,
  STATE_ATTR,
} from './segmenter';

type State = 'wait' | 'pending' | 'done' | 'same' | 'error' | 'hint';

/** 插入译文前后要检查的祖先层数 */
const GUARD_DEPTH = 6;

interface Overflow {
  node: Element;
  dy: number;
  dx: number;
}

/** 记录元素及其祖先当前的溢出量（内容超出盒子的像素） */
function measureOverflow(el: Element): Overflow[] {
  const out: Overflow[] = [];
  let n: Element | null = el;
  for (let i = 0; n && i < GUARD_DEPTH && n !== document.body && n !== document.documentElement; i++) {
    out.push({ node: n, dy: n.scrollHeight - n.clientHeight, dx: n.scrollWidth - n.clientWidth });
    n = n.parentElement;
  }
  return out;
}

/** 插入译文后，有没有哪个固定尺寸的容器因此溢出（被裁切或盖住相邻内容） */
function causedOverflow(before: Overflow[]): boolean {
  return before.some(({ node, dy, dx }) => {
    const ny = node.scrollHeight - node.clientHeight;
    const nx = node.scrollWidth - node.clientWidth;
    return ny > Math.max(dy, 0) + 2 || nx > Math.max(dx, 0) + 2;
  });
}

export async function translateBatch(texts: string[], s: Settings): Promise<string[]> {
  if (s.provider === 'builtin') {
    return translateBuiltin(texts, s.targetLang, document.documentElement.lang || 'en');
  }
  return sendMessage('translate', { texts });
}

export class PageTranslator {
  active = false;
  onChange?: (active: boolean) => void;

  private generation = 0; // 每次开/关递增，用来丢弃过期结果
  private io?: IntersectionObserver;
  private mo?: MutationObserver;
  private touched = new Set<Element>();
  private src = new WeakMap<Element, string>();
  private queue = new Set<Element>();
  private flushTimer = 0;
  private pendingRoots = new Set<Element>();
  private mutationTimer = 0;
  private hints = new WeakMap<Element, string>();
  /** 识别出的正文区域；null 表示不是文章类网页，按全页规则翻译 */
  private main: MainContent | null = null;

  constructor(private getSettings: () => Settings) {}

  private get settings() {
    return this.getSettings();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.generation++;
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: '600px 0px' });
    this.scanPage();
    this.mo = new MutationObserver((m) => this.onMutations(m));
    this.mo.observe(document.body, { childList: true, subtree: true });
    this.onChange?.(true);
  }

  restore() {
    this.active = false;
    this.generation++;
    this.io?.disconnect();
    this.mo?.disconnect();
    this.queue.clear();
    this.pendingRoots.clear();
    this.main = null;
    document.querySelectorAll('.bilingo-tr, .bilingo-loading, .bilingo-error').forEach((n) => n.remove());
    for (const el of this.touched) el.removeAttribute(STATE_ATTR);
    this.touched.clear();
    document.querySelectorAll('font.bilingo-wrap').forEach((w) => w.replaceWith(...w.childNodes));
    this.onChange?.(false);
  }

  toggle(): boolean {
    if (this.active) this.restore();
    else this.start();
    return this.active;
  }

  restyle(style: string) {
    document.querySelectorAll('.bilingo-tr').forEach((n) => {
      n.className = n.className.replace(/bilingo-style-\w+/, `bilingo-style-${style}`);
    });
  }

  // ---------- 内部 ----------

  private setState(el: Element, s: State) {
    el.setAttribute(STATE_ATTR, s);
  }

  private state(el: Element) {
    return el.getAttribute(STATE_ATTR) as State | null;
  }

  /** 智能模式下先识别正文区域：是文章页就只翻译正文和标题，否则翻译全页 */
  private scanPage() {
    this.main = this.settings.scope !== 'all' ? detectMainContent() : null;
    if (!this.main) {
      this.scan(document.body);
      return;
    }
    for (const r of [...this.main.headings, ...this.main.roots]) this.scan(r);
  }

  private inScope(el: Element): boolean {
    return !this.main || [...this.main.roots, ...this.main.headings].some((r) => r.contains(el));
  }

  private scan(root: Element) {
    const opts = { target: this.settings.targetLang, smart: this.settings.scope !== 'all' };
    for (const el of collectSegments(root, opts)) {
      this.src.set(el, getText(el));
      this.setState(el, 'wait');
      this.touched.add(el);
      this.io!.observe(el);
    }
  }

  private onIntersect(entries: IntersectionObserverEntry[]) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      this.io!.unobserve(e.target);
      void this.enqueue(e.target);
    }
  }

  private async enqueue(el: Element) {
    if (this.state(el) !== 'wait') return;
    // 只给读屏软件看的隐藏文字、跳转链接、未显示的 tooltip：不翻译（否则译文会出现在奇怪的位置）
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4 || isVisuallyHidden(el) || !this.src.get(el)) {
      this.setState(el, 'same');
      return;
    }
    this.setState(el, 'pending');
    const spin = document.createElement('font');
    spin.className = 'bilingo-loading';
    el.appendChild(spin);

    // 用浏览器内置语言检测跳过已是目标语言的段落（省 API 调用）；内置翻译会在内部自行检测
    if (this.settings.provider !== 'builtin') {
      const gen = this.generation;
      const lang = await detectLanguage(this.src.get(el)!);
      if (gen !== this.generation) return;
      if (lang && sameLanguage(lang, this.settings.targetLang)) {
        spin.remove();
        this.setState(el, 'same');
        return;
      }
    }

    this.queue.add(el);
    clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => this.flush(), 80);
  }

  private flush() {
    const items = [...this.queue].filter((el) => el.isConnected);
    this.queue.clear();
    const { maxChars, maxItems } = batchLimits(this.settings);
    let batch: Element[] = [];
    let chars = 0;
    for (const el of items) {
      const len = this.src.get(el)!.length;
      if (batch.length && (chars + len > maxChars || batch.length >= maxItems)) {
        void this.send(batch);
        batch = [];
        chars = 0;
      }
      batch.push(el);
      chars += len;
    }
    if (batch.length) void this.send(batch);
  }

  private async send(batch: Element[]) {
    const gen = this.generation;
    try {
      const result = await translateBatch(
        batch.map((el) => this.src.get(el)!),
        this.settings,
      );
      if (gen !== this.generation) return;
      this.insertAll(batch, result);
    } catch (e) {
      if (gen !== this.generation) return;
      batch.forEach((el) => this.markError(el, (e as Error).message || String(e)));
    }
  }

  private removeOwn(el: Element, cls: string) {
    for (const c of [...el.children]) if (c.classList.contains(cls)) c.remove();
  }

  /** 布局受限、放不下译文的段落：鼠标悬停时显示的译文 */
  hintOf(el: Element): string | undefined {
    return this.hints.get(el);
  }

  /**
   * 批量插入译文，并检查是否破坏布局：
   * 先读（插入前的溢出量）→ 再写（插入全部译文）→ 再读（插入后的溢出量），整批只触发两次排版。
   * 如果某段译文让固定高度 / 宽度的容器溢出，就撤回该译文，改为悬停显示。
   */
  private insertAll(els: Element[], results: string[]) {
    const items: { el: Element; tr: string }[] = [];
    els.forEach((el, i) => {
      this.removeOwn(el, 'bilingo-loading');
      const tr = results[i]?.trim();
      if (!el.isConnected || !tr || tr === this.src.get(el)) this.setState(el, 'same');
      else items.push({ el, tr });
    });
    const before = items.map(({ el }) => measureOverflow(el));
    const nodes = items.map(({ el, tr }) => this.appendTranslation(el, tr));
    items.forEach(({ el, tr }, k) => {
      if (causedOverflow(before[k]!)) {
        nodes[k]!.remove();
        this.hints.set(el, tr);
        this.setState(el, 'hint');
      } else {
        this.setState(el, 'done');
      }
    });
  }

  private appendTranslation(el: Element, tr: string): Element {
    const src = this.src.get(el)!;
    const node = document.createElement('font');
    const mode = preferInline(el, src) ? 'bilingo-inline' : 'bilingo-block';
    node.className = `bilingo-tr ${mode} bilingo-style-${this.settings.style}`;
    node.setAttribute('translate', 'no');
    node.textContent = tr; // 只作为纯文本插入，杜绝 XSS
    el.appendChild(node);
    return node;
  }

  private markError(el: Element, message: string) {
    this.removeOwn(el, 'bilingo-loading');
    const err = document.createElement('font');
    err.className = 'bilingo-error';
    err.textContent = ' ⚠ 重试';
    err.title = message;
    err.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      err.remove();
      this.setState(el, 'wait');
      void this.enqueue(el);
    });
    el.appendChild(err);
    this.setState(el, 'error');
  }

  private onMutations(muts: MutationRecord[]) {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (isOwnNode(n)) continue;
        if (n instanceof Element) this.pendingRoots.add(n);
        else if (n.nodeType === Node.TEXT_NODE && n.parentElement) this.pendingRoots.add(n.parentElement);
      }
    }
    if (this.pendingRoots.size) {
      clearTimeout(this.mutationTimer);
      this.mutationTimer = window.setTimeout(() => this.processMutations(), 300);
    }
  }

  private processMutations() {
    const roots = [...this.pendingRoots];
    this.pendingRoots.clear();
    // 单页应用换了页面、原来的正文区域已不在：重新识别
    if (this.main && this.main.roots.every((r) => !r.isConnected)) {
      this.scanPage();
      return;
    }
    for (const r of roots) {
      if (!r.isConnected || r.closest(`[${STATE_ATTR}]`) || r.closest(SKIP_CONTEXT) || !this.inScope(r)) continue;
      this.scan(r);
    }
  }
}

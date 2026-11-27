// 页面翻译调度：段落进入视口 → 语言检测 → 分批翻译 → 插入译文；同时监听动态内容
import { detectLanguage, translateBuiltin } from '@/shared/builtin';
import { sameLanguage } from '@/shared/langs';
import { sendMessage } from '@/shared/messaging';
import { batchLimits, type Settings } from '@/shared/settings';
import { collectSegments, getText, isOwnNode, preferInline, SKIP_CONTEXT, STATE_ATTR } from './segmenter';

type State = 'wait' | 'pending' | 'done' | 'same' | 'error';

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

  constructor(private getSettings: () => Settings) {}

  private get settings() {
    return this.getSettings();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.generation++;
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: '600px 0px' });
    this.scan(document.body);
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

  private scan(root: Element) {
    for (const el of collectSegments(root, this.settings.targetLang)) {
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
      batch.forEach((el, i) => this.insert(el, result[i]));
    } catch (e) {
      if (gen !== this.generation) return;
      batch.forEach((el) => this.markError(el, (e as Error).message || String(e)));
    }
  }

  private removeOwn(el: Element, cls: string) {
    for (const c of [...el.children]) if (c.classList.contains(cls)) c.remove();
  }

  private insert(el: Element, text: string | undefined) {
    this.removeOwn(el, 'bilingo-loading');
    const src = this.src.get(el)!;
    const tr = text?.trim();
    if (!tr || tr === src) {
      this.setState(el, 'same');
      return;
    }
    const node = document.createElement('font');
    const mode = preferInline(el, src) ? 'bilingo-inline' : 'bilingo-block';
    node.className = `bilingo-tr ${mode} bilingo-style-${this.settings.style}`;
    node.setAttribute('translate', 'no');
    node.textContent = tr; // 只作为纯文本插入，杜绝 XSS
    el.appendChild(node);
    this.setState(el, 'done');
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
    for (const r of roots) {
      if (!r.isConnected || r.closest(`[${STATE_ATTR}]`) || r.closest(SKIP_CONTEXT)) continue;
      this.scan(r);
    }
  }
}

// 网页元素点选器：在网页上点选一块区域，生成网站规则（不翻译这里 / 只翻译这里）。
// 交互参考 uBlock Origin 的元素选择器：悬停高亮 → 点击锁定 → 扩大 / 缩小范围、预览匹配到的所有区域 → 确认。
import { m } from '@/shared/i18n';
import { isValidSelector } from '@/shared/site-rules';
import { selectorFor } from './selector';

export type PickAction = 'exclude' | 'include';

const MAX_PREVIEW = 100;

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
    color-scheme: light dark; font-family: system-ui, -apple-system, 'Segoe UI Variable Text', 'PingFang SC', 'Microsoft YaHei UI', sans-serif;
    --accent: oklch(0.58 0.21 274); }
  .box { position: fixed; border: 2px solid var(--accent); background: oklch(0.6 0.2 274 / 0.14); border-radius: 4px;
    transition: all .08s ease-out; }
  .box.match { border-style: dashed; background: oklch(0.6 0.2 274 / 0.08); }
  .panel { position: fixed; left: 50%; bottom: 20px; translate: -50% 0; width: min(560px, calc(100vw - 24px));
    pointer-events: auto; padding: 12px 14px; border-radius: 14px; font-size: 13px; line-height: 1.5;
    color: light-dark(oklch(0.24 0.02 274), oklch(0.94 0.008 274));
    background: light-dark(oklch(1 0 0 / 0.96), oklch(0.24 0.012 274 / 0.96)); backdrop-filter: blur(14px);
    border: 1px solid light-dark(oklch(0.2 0.02 274 / 0.12), oklch(1 0 0 / 0.14));
    box-shadow: 0 16px 40px -12px oklch(0.2 0.04 274 / 0.4); }
  .hint { opacity: .8; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  input { flex: 1; min-width: 200px; height: 32px; padding: 0 10px; border-radius: 8px; font: 12px ui-monospace, Consolas, monospace;
    color: inherit; background: light-dark(oklch(0.96 0.006 274), oklch(0.3 0.012 274));
    border: 1px solid light-dark(oklch(0.84 0.012 274), oklch(0.4 0.015 274)); }
  input.bad { border-color: oklch(0.6 0.2 25); }
  .count { opacity: .75; white-space: nowrap; }
  button { height: 30px; padding: 0 12px; border-radius: 8px; font-family: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer;
    color: inherit; background: light-dark(oklch(1 0 0), oklch(0.3 0.012 274));
    border: 1px solid light-dark(oklch(0.84 0.012 274), oklch(0.4 0.015 274)); }
  button:hover { border-color: var(--accent); }
  button.primary { color: #fff; background: var(--accent); border-color: transparent; }
  button:disabled { opacity: .4; cursor: default; }
  .sp { flex: 1; }
  [hidden] { display: none !important; }
`;

export class ElementPicker {
  private host: HTMLElement | null = null;
  private box!: HTMLDivElement;
  private matches!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private input!: HTMLInputElement;
  private count!: HTMLSpanElement;
  /** 锁定的元素；history 用于"缩小"回到更小的范围 */
  private locked: Element | null = null;
  private history: Element[] = [];

  constructor(private onPick: (action: PickAction, selector: string) => void) {}

  get active() {
    return !!this.host;
  }

  start() {
    if (this.host) return;
    this.host = document.createElement('div');
    this.host.id = 'bilingo-picker';
    const shadow = this.host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="layer">
        <div class="matches"></div>
        <div class="box" hidden></div>
        <div class="panel">
          <div class="hint"></div>
          <div class="row locked" hidden>
            <input spellcheck="false" aria-label="CSS selector">
            <span class="count"></span>
          </div>
          <div class="row locked" hidden>
            <button class="expand"></button><button class="shrink"></button>
            <span class="sp"></span>
            <button class="cancel"></button>
            <button class="exclude primary"></button><button class="include"></button>
          </div>
        </div>
      </div>`;
    const q = <T extends Element>(s: string) => shadow.querySelector<T>(s)!;
    this.box = q('.box');
    this.matches = q('.matches');
    this.panel = q('.panel');
    this.input = q('input');
    this.count = q('.count');
    q('.hint').textContent = m.picker_hint();
    q('.expand').textContent = m.picker_expand();
    q('.shrink').textContent = m.picker_shrink();
    q('.cancel').textContent = m.picker_cancel();
    q('.exclude').textContent = m.picker_exclude();
    q('.include').textContent = m.picker_include();
    q('.expand').addEventListener('click', () => this.expand());
    q('.shrink').addEventListener('click', () => this.shrink());
    q('.cancel').addEventListener('click', () => this.stop());
    q('.exclude').addEventListener('click', () => this.finish('exclude'));
    q('.include').addEventListener('click', () => this.finish('include'));
    this.input.addEventListener('input', () => this.preview());
    document.documentElement.appendChild(this.host);

    document.addEventListener('mousemove', this.onMove, true);
    document.addEventListener('click', this.onClick, true);
    document.addEventListener('keydown', this.onKey, true);
    addEventListener('scroll', this.onScroll, true);
    addEventListener('resize', this.onScroll);
  }

  stop() {
    document.removeEventListener('mousemove', this.onMove, true);
    document.removeEventListener('click', this.onClick, true);
    document.removeEventListener('keydown', this.onKey, true);
    removeEventListener('scroll', this.onScroll, true);
    removeEventListener('resize', this.onScroll);
    this.host?.remove();
    this.host = null;
    this.locked = null;
    this.history = [];
  }

  private isOwn(e: Event) {
    return e.composedPath().some((n) => n instanceof Element && (n === this.host || n.id === 'bilingo-host'));
  }

  private onMove = (e: MouseEvent) => {
    if (this.locked || this.isOwn(e)) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== document.documentElement && el !== document.body) this.drawBox(this.box, el);
  };

  private onClick = (e: MouseEvent) => {
    if (this.isOwn(e)) return;
    // 点选期间屏蔽网页本身的点击（链接、按钮）
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === document.documentElement || el === document.body) return;
    this.history = [];
    this.lock(el);
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.stop();
    }
  };

  private onScroll = () => {
    if (this.locked) this.preview();
  };

  private lock(el: Element) {
    this.locked = el;
    this.input.value = selectorFor(el);
    for (const r of this.panel.querySelectorAll<HTMLElement>('.locked')) r.hidden = false;
    this.preview();
  }

  private expand() {
    const p = this.locked?.parentElement;
    if (!this.locked || !p || p === document.body || p === document.documentElement) return;
    this.history.push(this.locked);
    this.lock(p);
  }

  private shrink() {
    const prev = this.history.pop();
    if (prev) this.lock(prev);
  }

  /** 高亮锁定的元素，并用虚线框标出当前选择器匹配到的所有区域 */
  private preview() {
    const sel = this.input.value.trim();
    const valid = !!sel && isValidSelector(sel);
    this.input.classList.toggle('bad', !valid);
    const found = valid ? [...document.querySelectorAll(sel)].filter((el) => !this.host?.contains(el)) : [];
    this.count.textContent = m.picker_matches({ n: found.length });
    this.matches.replaceChildren(
      ...found.slice(0, MAX_PREVIEW).map((el) => {
        const b = document.createElement('div');
        b.className = 'box match';
        this.drawBox(b, el);
        return b;
      }),
    );
    if (this.locked) this.drawBox(this.box, this.locked);
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>('.exclude, .include')) b.disabled = !found.length;
    (this.panel.querySelector('.shrink') as HTMLButtonElement).disabled = !this.history.length;
  }

  private drawBox(b: HTMLElement, el: Element) {
    const r = el.getBoundingClientRect();
    b.hidden = false;
    Object.assign(b.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  private finish(action: PickAction) {
    const sel = this.input.value.trim();
    if (!sel || !isValidSelector(sel)) return;
    this.stop();
    this.onPick(action, sel);
  }
}

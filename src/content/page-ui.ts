// 悬浮按钮 + 划词翻译气泡，放在 Shadow DOM 里，与网页样式互不干扰
import { m } from '@/shared/i18n';
import { storage } from 'wxt/utils/storage';
import { HOST_ID } from './segmenter';
import LOGO_SVG from '../../assets/logo.svg?raw';

/** 悬浮按钮位置：贴靠左 / 右边缘，top 为视口高度的比例（窗口缩放后仍在相对位置） */
export interface BallPos {
  side: 'left' | 'right';
  top: number;
}
const ballPosItem = storage.defineItem<BallPos>('local:ballPos', { fallback: { side: 'right', top: 0.8 } });

const BALL = 38;
const EDGE = 14;
/** 移动超过该距离才算拖动，否则视为点击 */
const DRAG_THRESHOLD = 4;
/** 视口宽度（不含滚动条） */
const vw = () => document.documentElement.clientWidth || innerWidth;

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON_COPY = svg(
  '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
);
const ICON_CHECK = svg('<path d="M20 6 9 17l-5-5"/>');
const ICON_X = svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .ball, .bubble {
    color-scheme: light dark;
    --accent: light-dark(oklch(0.55 0.21 274), oklch(0.72 0.16 274));
    --gradient: linear-gradient(135deg, oklch(0.6 0.2 264), oklch(0.58 0.22 298));
    --surface: light-dark(oklch(1 0 0 / 0.86), oklch(0.24 0.012 274 / 0.86));
    --fg: light-dark(oklch(0.24 0.02 274), oklch(0.94 0.008 274));
    --muted: light-dark(oklch(0.52 0.02 274), oklch(0.7 0.015 274));
    --border: light-dark(oklch(0.2 0.02 274 / 0.1), oklch(1 0 0 / 0.12));
    --ease: cubic-bezier(0.2, 0, 0, 1);
    font-family: system-ui, -apple-system, 'Segoe UI Variable Text', 'PingFang SC', 'Microsoft YaHei UI', sans-serif;
  }

  /* 悬浮按钮 = Bilingo 图标：上面的气泡是原文，下面的是译文。
     未翻译时译文气泡半透明、颜色略淡；翻译后译文气泡变实，并加一圈光晕 */
  .ball {
    position: fixed; top: 80vh; right: ${EDGE}px; left: auto; z-index: 2147483646;
    display: block; width: ${BALL}px; height: ${BALL}px; padding: 0;
    border: none; border-radius: ${Math.round((BALL * 30) / 128)}px; background: none;
    box-shadow: 0 4px 14px -2px oklch(0.35 0.15 280 / 0.45), 0 1px 3px oklch(0 0 0 / 0.12);
    opacity: 0.72; filter: saturate(0.75); cursor: pointer; touch-action: none; user-select: none;
    transition: opacity .2s var(--ease), scale .2s var(--ease), left .25s var(--ease), top .25s var(--ease),
      filter .2s, box-shadow .2s;
  }
  .ball svg { display: block; width: 100%; height: 100%; }
  .ball .mark-tr { fill-opacity: 0.5; transition: fill-opacity .25s var(--ease); }
  .ball:hover, .ball:focus-visible, .ball.dragging { opacity: 1; filter: none; scale: 1.08; }
  .ball:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .ball.on {
    opacity: 1; filter: none;
    box-shadow: 0 0 0 3px oklch(0.62 0.2 280 / 0.28), 0 6px 18px -4px oklch(0.55 0.21 280 / 0.6);
  }
  .ball.on .mark-tr { fill-opacity: 1; }
  .ball.dragging { cursor: grabbing; scale: 1.12; transition: none; }

  /* 划词翻译气泡 */
  .bubble {
    position: fixed; z-index: 2147483647; width: max-content; max-width: min(440px, calc(100vw - 16px));
    min-width: 200px; overflow: hidden;
    border: 1px solid var(--border); border-radius: 14px;
    font-size: 14px; line-height: 1.6; color: var(--fg);
    background: light-dark(oklch(1 0 0 / 0.94), oklch(0.24 0.012 274 / 0.94));
    backdrop-filter: blur(16px) saturate(1.6);
    box-shadow: 0 16px 40px -12px oklch(0.2 0.04 274 / 0.35), 0 2px 8px oklch(0 0 0 / 0.08);
    opacity: 1; translate: 0 0;
    transition: opacity .16s var(--ease), translate .16s var(--ease), display .16s allow-discrete;
  }
  @starting-style { .bubble { opacity: 0; translate: 0 4px; } }
  .head { display: flex; align-items: center; gap: 6px; padding: 7px 8px 0 12px; font-size: 12px; color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gradient); }
  .head .sp { flex: 1; }
  .head button {
    display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: none; border-radius: 7px;
    color: var(--muted); background: transparent; cursor: pointer;
  }
  .head button:hover { color: var(--fg); background: light-dark(oklch(0.2 0.02 274 / 0.07), oklch(1 0 0 / 0.1)); }
  .head button.done { color: oklch(0.6 0.15 155); }
  .body { padding: 4px 14px 12px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 50vh; overflow: auto; }
  .bubble.err .body { color: light-dark(oklch(0.55 0.2 25), oklch(0.75 0.16 25)); }
  .bubble.loading .body { color: var(--muted); }
  .bubble.loading .dot { animation: pulse 1s ease-in-out infinite; }
  .bubble.loading .copy { display: none; }
  .bubble.hint { pointer-events: none; }
  .bubble.hint .head button { display: none; }
  @keyframes pulse { 50% { opacity: .3; scale: .7; } }
  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

export type BubbleState = 'loading' | 'ok' | 'error';

export class PageUI {
  private host: HTMLElement;
  private ball: HTMLButtonElement;
  private bubble: HTMLDivElement;
  private bubbleBody: HTMLDivElement;
  private copyBtn: HTMLButtonElement;
  private pos: BallPos = ballPosItem.fallback;

  constructor(onBallClick: () => void) {
    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    const shadow = this.host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>
      <button class="ball" hidden>${LOGO_SVG.replace(/<title>[^<]*<\/title>/, '')}</button>
      <div class="bubble" role="dialog" hidden>
        <div class="head"><span class="dot"></span><span class="head-title"></span><span class="sp"></span>
          <button class="copy">${ICON_COPY}</button>
          <button class="close">${ICON_X}</button>
        </div>
        <div class="body"></div>
      </div>`;
    this.ball = shadow.querySelector('.ball')!;
    this.bubble = shadow.querySelector('.bubble')!;
    this.bubbleBody = shadow.querySelector('.body')!;
    this.copyBtn = shadow.querySelector('.copy')!;
    shadow.querySelector('.close')!.addEventListener('click', () => this.hideBubble());
    this.copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(this.bubbleBody.textContent ?? '').then(() => {
        this.copyBtn.innerHTML = ICON_CHECK;
        this.copyBtn.classList.add('done');
        setTimeout(() => {
          this.copyBtn.innerHTML = ICON_COPY;
          this.copyBtn.classList.remove('done');
        }, 1200);
      });
    });
    this.applyLabels();
    this.initDrag(onBallClick);
    void ballPosItem.getValue().then((p) => this.applyPos(p));
    // 在其他标签页拖动后同步位置
    ballPosItem.watch((p) => this.applyPos(p));
    addEventListener('resize', () => this.applyPos(this.pos));

    document.addEventListener('mousedown', (e) => {
      if (!e.composedPath().includes(this.host)) this.hideBubble();
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.hideBubble());
  }

  /** 悬浮球的提示文字（浏览器自带的 PDF 查看器里改为"用 Bilingo 打开"） */
  ballTitle?: () => string;

  /** 按当前界面语言设置所有文字（切换语言时再次调用） */
  applyLabels() {
    const shadow = this.host.shadowRoot!;
    const set = (sel: string, label: string, title = label) => {
      const el = shadow.querySelector(sel)!;
      el.setAttribute('aria-label', label);
      el.setAttribute('title', title);
    };
    set('.ball', this.ballTitle?.() ?? m.ball_label(), this.ballTitle?.() ?? m.ball_title());
    set('.copy', m.bubble_copy());
    set('.close', m.bubble_close());
    this.bubble.setAttribute('aria-label', m.bubble_label());
    shadow.querySelector('.head-title')!.textContent = m.bubble_head();
  }

  private applyPos(p: BallPos) {
    this.pos = p;
    const s = this.ball.style;
    const maxTop = Math.max(EDGE, innerHeight - BALL - EDGE);
    s.top = `${Math.min(Math.max(EDGE, p.top * innerHeight), maxTop)}px`;
    s.left = `${p.side === 'left' ? EDGE : vw() - BALL - EDGE}px`;
    s.right = 'auto';
  }

  /** 指针拖动：任意方向移动，松开后吸附到最近的左 / 右边缘；没拖动则视为点击 */
  private initDrag(onClick: () => void) {
    const ball = this.ball;
    let start: { x: number; y: number; left: number; top: number } | null = null;
    let dragging = false;

    ball.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = ball.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      dragging = false;
      ball.setPointerCapture(e.pointerId);
    });
    ball.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragging = true;
      ball.classList.add('dragging');
      const left = Math.min(Math.max(0, start.left + dx), vw() - BALL);
      const top = Math.min(Math.max(0, start.top + dy), innerHeight - BALL);
      Object.assign(ball.style, { left: `${left}px`, top: `${top}px`, right: 'auto' });
    });
    const end = (e: PointerEvent, cancelled: boolean) => {
      if (!start) return;
      start = null;
      if (ball.hasPointerCapture(e.pointerId)) ball.releasePointerCapture(e.pointerId);
      if (!dragging) {
        if (!cancelled) onClick();
        return;
      }
      ball.classList.remove('dragging');
      const r = ball.getBoundingClientRect();
      const pos: BallPos = {
        side: r.left + BALL / 2 < vw() / 2 ? 'left' : 'right',
        top: r.top / innerHeight,
      };
      // 移除 dragging 后过渡动画生效，平滑吸附到边缘
      requestAnimationFrame(() => this.applyPos(pos));
      void ballPosItem.setValue(pos);
    };
    ball.addEventListener('pointerup', (e) => end(e, false));
    ball.addEventListener('pointercancel', (e) => end(e, true));
    // 键盘操作（Enter / 空格）仍触发点击；指针点击已在 pointerup 中处理
    ball.addEventListener('click', (e) => {
      if (e.detail === 0) onClick();
    });
  }

  private mount() {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
  }

  setBall(visible: boolean, active: boolean) {
    this.mount();
    this.ball.hidden = !visible;
    this.ball.classList.toggle('on', active);
  }

  /** 是否是悬停提示（悬停提示在鼠标离开时自动关闭，不影响划词翻译气泡） */
  private isHint = false;

  showBubble(rect: DOMRect, text: string, state: BubbleState = 'ok', hint = false) {
    this.mount();
    const b = this.bubble;
    this.isHint = hint;
    b.classList.toggle('hint', hint);
    this.bubbleBody.textContent = text;
    b.classList.toggle('err', state === 'error');
    b.classList.toggle('loading', state === 'loading');
    b.hidden = false;
    const below = rect.bottom + 8;
    const top = below + b.offsetHeight > innerHeight ? Math.max(8, rect.top - 8 - b.offsetHeight) : below;
    b.style.top = `${top}px`;
    b.style.left = `${Math.min(Math.max(8, rect.left), vw() - b.offsetWidth - 8)}px`;
  }

  hideHint() {
    if (this.isHint) this.hideBubble();
  }

  hideBubble() {
    this.bubble.hidden = true;
  }
}

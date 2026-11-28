// 字幕显示层（Shadow DOM，样式与网页隔离）：状态提示 + 原文 + 译文
import type { Frame } from './engine';

const CSS = `
  :host { all: initial; }
  .wrap { position: absolute; left: 0; right: 0; bottom: 9%; z-index: 60; display: flex; flex-direction: column;
    align-items: center; gap: .15em; pointer-events: none; transition: bottom .2s;
    font-family: "YouTube Noto", Roboto, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei UI", sans-serif; }
  .wrap.raised { bottom: calc(9% + 40px); }
  .line { max-width: 86%; padding: .08em .45em; border-radius: .15em; text-align: center; line-height: 1.35;
    color: #fff; background: rgba(8, 8, 8, .75); white-space: pre-wrap; overflow-wrap: anywhere; }
  .tr { color: #ffe9a8; }
  .status { font-size: .7em; opacity: .9; }
  [hidden] { display: none !important; }
`;

export class SubtitleOverlay {
  readonly host: HTMLElement;
  private wrap: HTMLElement;
  private srcLine: HTMLElement;
  private trLine: HTMLElement;
  private statusLine: HTMLElement;

  constructor(id: string, zIndex = '60', extraCss = '') {
    this.host = document.createElement('div');
    this.host.id = id;
    Object.assign(this.host.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex });
    const shadow = this.host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}${extraCss}</style>
      <div class="wrap"><div class="line status" hidden></div><div class="line src" hidden></div><div class="line tr" hidden></div></div>`;
    this.wrap = shadow.querySelector('.wrap')!;
    this.statusLine = shadow.querySelector('.status')!;
    this.srcLine = shadow.querySelector('.src')!;
    this.trLine = shadow.querySelector('.tr')!;
  }

  get shadow(): ShadowRoot {
    return this.host.shadowRoot!;
  }

  /** 挂到容器里（已在其中时不动） */
  mount(parent: Element) {
    if (this.host.parentElement !== parent) parent.appendChild(this.host);
  }

  remove() {
    this.host.remove();
  }

  /** 字号随视频高度变化（全屏时更大）；raised：控制栏显示时把字幕抬高 */
  layout(videoHeight: number, raised: boolean, hidden = false) {
    this.wrap.style.fontSize = `${Math.max(14, Math.min(40, videoHeight * 0.042))}px`;
    this.wrap.classList.toggle('raised', raised);
    this.wrap.hidden = hidden;
  }

  show(frame: Frame) {
    this.srcLine.hidden = !frame.src;
    this.srcLine.textContent = frame.src ?? '';
    this.trLine.hidden = !frame.tr;
    this.trLine.textContent = frame.tr ?? '';
  }

  setStatus(text: string) {
    this.statusLine.textContent = text;
    this.statusLine.hidden = !text;
  }
}

// YouTube 双语字幕（内容脚本 / 隔离环境）
// 流程：主环境脚本拦截到播放器的字幕请求（带令牌的网址）→ 这里重新获取 json3 → 拼成句子 →
// 按播放进度分批翻译（当前位置往后约 60 秒，快播完时补下一批，拖动进度时立即翻译新位置）→ 在播放器里叠加显示原文 + 译文。
import LOGO_SVG from '../../assets/logo.svg?raw';
import { m } from '@/shared/i18n';
import { sameLanguage } from '@/shared/langs';
import { batchLimits, type Settings } from '@/shared/settings';
import { translateBatch } from '@/shared/translate-client';
import { cueAt, parseJson3, type Cue, type Json3 } from './captions';

const SOURCE = 'bilingo-yt';
/** 每次往后翻译的时长、提前多久补下一批 */
const WINDOW_MS = 60_000;
const PREFETCH_MS = 40_000;
/** 拿不到字幕网址时重新询问的时间点；最终等多久仍拿不到就提示"没有字幕" */
const RETRY_MS = [3000, 6000];
const CAPTIONS_TIMEOUT_MS = 10_000;
/** 翻译失败后等多久再重试 */
const RETRY_AFTER_FAILURE_MS = 10_000;

const OVERLAY_CSS = `
  :host { all: initial; }
  .wrap { position: absolute; left: 0; right: 0; bottom: 9%; z-index: 60; display: flex; flex-direction: column;
    align-items: center; gap: .15em; pointer-events: none; transition: bottom .2s;
    font-family: "YouTube Noto", Roboto, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei UI", sans-serif; }
  .wrap.controls { bottom: calc(9% + 40px); }
  .line { max-width: 86%; padding: .08em .45em; border-radius: .15em; text-align: center; line-height: 1.35;
    color: #fff; background: rgba(8, 8, 8, .75); white-space: pre-wrap; overflow-wrap: anywhere; }
  .tr { color: #ffe9a8; }
  .status { font-size: .7em; opacity: .9; }
  [hidden] { display: none !important; }
`;

/** 播放器控制栏里的按钮使用 YouTube 自己的 .ytp-button 样式，只补充图标尺寸与开关状态 */
const PAGE_CSS = `
  .bilingo-yt-btn { display: inline-flex !important; align-items: center; justify-content: center; vertical-align: top; }
  .bilingo-yt-btn svg { width: 24px; height: 24px; opacity: .65; filter: grayscale(1); transition: opacity .15s, filter .15s; }
  .bilingo-yt-btn[aria-pressed="true"] svg { opacity: 1; filter: none; }
  html.bilingo-yt-on .ytp-caption-window-container { display: none !important; }
`;

interface Player extends HTMLElement {
  querySelector<E extends Element = Element>(selectors: string): E | null;
}

export class YoutubeSubtitles {
  /** 每个视频最近一次捕获到的字幕网址 */
  private urls = new Map<string, string>();
  private videoId: string | null = null;
  private loadedUrl = '';
  private cues: Cue[] = [];
  private sourceLang = '';
  private translations = new Map<number, string>();
  private pending = new Set<number>();
  /** 已经请求翻译到的时间点（毫秒） */
  private horizon = 0;
  /** 翻译失败后，到这个时间之前不再重试 */
  private retryAt = 0;
  private host: HTMLElement | null = null;
  private wrap!: HTMLElement;
  private srcLine!: HTMLElement;
  private trLine!: HTMLElement;
  private statusLine!: HTMLElement;
  private shown = -2;
  private raf = 0;
  private timeout = 0;
  private generation = 0;

  constructor(private getSettings: () => Settings) {}

  private get enabled() {
    return this.getSettings().ytSubtitles;
  }

  start() {
    const style = document.createElement('style');
    style.textContent = PAGE_CSS;
    (document.head ?? document.documentElement).appendChild(style);

    window.addEventListener('message', (e: MessageEvent<{ source?: string; type?: string; url?: string }>) => {
      if (e.source !== window || e.data?.source !== SOURCE || e.data.type !== 'timedtext' || !e.data.url) return;
      this.onCaptured(e.data.url);
    });
    // YouTube 是单页应用：切换视频不刷新页面
    document.addEventListener('yt-navigate-finish', () => this.onNavigate());
    addEventListener('popstate', () => this.onNavigate());
    // 播放器控制栏是动态生成的，定期确认按钮还在
    setInterval(() => this.ensureButton(), 1500);
    this.onNavigate();
  }

  /** 设置变化（开关、翻译服务、目标语言）后调用 */
  refresh() {
    this.updateButton();
    this.reset();
    if (this.enabled) this.activate();
  }

  // ---------- 视频与字幕 ----------

  private currentVideoId(): string | null {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    return /^\/(?:shorts|live)\/([\w-]+)/.exec(u.pathname)?.[1] ?? null;
  }

  private onNavigate() {
    const id = this.currentVideoId();
    if (id === this.videoId) return;
    this.videoId = id;
    this.reset();
    this.ensureButton();
    if (id && this.enabled) this.activate();
  }

  private onCaptured(url: string) {
    const id = new URL(url).searchParams.get('v');
    if (!id) return;
    this.urls.set(id, url);
    // 用户在字幕菜单里换了轨道，播放器会再请求一次：跟随
    if (id === this.videoId && this.enabled && url !== this.loadedUrl) void this.load(url);
  }

  private activate() {
    if (!this.videoId) return;
    const url = this.urls.get(this.videoId);
    if (url) {
      void this.load(url);
      return;
    }
    this.mount();
    this.setStatus(m.yt_loading());
    // 向主环境要已捕获的字幕网址；还没有的话，它会让播放器重新请求字幕（会被拦截到）。
    // 播放器可能还没初始化好，所以拿不到时隔几秒再问一次
    const ask = () => {
      if (!this.loadedUrl && this.enabled) {
        window.postMessage({ source: SOURCE, type: 'request-captions', videoId: this.videoId }, location.origin);
      }
    };
    ask();
    for (const delay of RETRY_MS) setTimeout(ask, delay);
    clearTimeout(this.timeout);
    this.timeout = window.setTimeout(() => {
      if (!this.cues.length && this.enabled) this.setStatus(m.yt_no_captions());
    }, CAPTIONS_TIMEOUT_MS);
  }

  private async load(url: string) {
    const gen = ++this.generation;
    this.loadedUrl = url;
    clearTimeout(this.timeout);
    this.mount();
    this.setStatus(m.yt_loading());
    try {
      const u = new URL(url);
      u.searchParams.set('fmt', 'json3');
      const res = await fetch(u, { credentials: 'include' });
      const text = await res.text();
      if (gen !== this.generation) return;
      if (!res.ok || !text) throw new Error(res.ok ? 'empty response' : `HTTP ${res.status}`);
      this.cues = parseJson3(JSON.parse(text) as Json3);
      this.sourceLang = u.searchParams.get('lang') ?? '';
      this.translations.clear();
      this.pending.clear();
      this.horizon = 0;
      this.shown = -2;
      if (!this.cues.length) {
        this.setStatus(m.yt_no_captions());
        return;
      }
      this.setStatus('');
      document.documentElement.classList.add('bilingo-yt-on');
      this.loop();
    } catch (e) {
      if (gen === this.generation) this.setStatus(m.yt_load_failed({ msg: (e as Error).message }));
    }
  }

  private reset() {
    this.generation++;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timeout);
    this.cues = [];
    this.translations.clear();
    this.pending.clear();
    this.loadedUrl = '';
    this.horizon = 0;
    this.shown = -2;
    document.documentElement.classList.remove('bilingo-yt-on');
    this.host?.remove();
    this.host = null;
  }

  // ---------- 翻译 ----------

  private needsTranslation() {
    return !this.sourceLang || !sameLanguage(this.sourceLang, this.getSettings().targetLang);
  }

  /** 翻译 [from, to) 时间范围内还没翻译的句子 */
  private translateRange(from: number, to: number) {
    if (!this.needsTranslation()) return;
    const s = this.getSettings();
    const gen = this.generation;
    const idx: number[] = [];
    this.cues.forEach((c, i) => {
      if (c.end > from && c.start < to && !this.translations.has(i) && !this.pending.has(i)) idx.push(i);
    });
    const { maxChars, maxItems } = batchLimits(s);
    let batch: number[] = [];
    let chars = 0;
    const send = (items: number[]) => {
      items.forEach((i) => this.pending.add(i));
      translateBatch(
        items.map((i) => this.cues[i]!.text),
        s,
        this.sourceLang || undefined,
      )
        .then((out) => {
          if (gen !== this.generation) return;
          items.forEach((i, k) => out[k] && this.translations.set(i, out[k]));
          this.shown = -2; // 让当前字幕重新渲染出译文
          this.setStatus('');
        })
        .catch((e: unknown) => {
          // 翻译失败要让用户知道（例如没配置 API Key），否则只会看到译文一直不出现；拖动进度或稍后会重试
          if (gen !== this.generation) return;
          this.setStatus(m.translate_failed({ msg: (e as Error).message || String(e) }));
          this.horizon = 0;
          this.retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
        })
        .finally(() => items.forEach((i) => this.pending.delete(i)));
    };
    for (const i of idx) {
      const len = this.cues[i]!.text.length;
      if (batch.length && (chars + len > maxChars || batch.length >= maxItems)) {
        send(batch);
        batch = [];
        chars = 0;
      }
      batch.push(i);
      chars += len;
    }
    if (batch.length) send(batch);
    this.horizon = Math.max(this.horizon, to);
  }

  // ---------- 渲染 ----------

  private player(): Player | null {
    return document.querySelector<Player>('#movie_player');
  }

  private mount() {
    const player = this.player();
    if (!player) return;
    if (this.host?.isConnected && this.host.parentElement === player) return;
    this.host?.remove();
    this.host = document.createElement('div');
    this.host.id = 'bilingo-yt-subs';
    Object.assign(this.host.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '60' });
    const shadow = this.host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${OVERLAY_CSS}</style>
      <div class="wrap"><div class="line status" hidden></div><div class="line src" hidden></div><div class="line tr" hidden></div></div>`;
    this.wrap = shadow.querySelector('.wrap')!;
    this.statusLine = shadow.querySelector('.status')!;
    this.srcLine = shadow.querySelector('.src')!;
    this.trLine = shadow.querySelector('.tr')!;
    player.appendChild(this.host);
  }

  private setStatus(text: string) {
    if (!this.host) return;
    this.statusLine.textContent = text;
    this.statusLine.hidden = !text;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const player = this.player();
    const video = player?.querySelector<HTMLVideoElement>('video');
    if (!player || !video) return;
    this.mount();
    // 字号随播放器高度变化（全屏时更大）
    this.wrap.style.fontSize = `${Math.max(14, Math.min(40, player.clientHeight * 0.042))}px`;
    this.wrap.classList.toggle('controls', !player.classList.contains('ytp-autohide'));
    const ad = player.classList.contains('ad-showing');
    this.wrap.hidden = ad;
    if (ad) return;

    const t = video.currentTime * 1000;
    // 往后预翻译；拖动到还没翻译的位置时立即翻译
    const due = t + PREFETCH_MS > this.horizon || t < this.horizon - WINDOW_MS * 2;
    if (due && Date.now() >= this.retryAt) {
      if (t < this.horizon - WINDOW_MS * 2) this.horizon = 0;
      this.translateRange(t, t + WINDOW_MS);
    }
    const i = cueAt(this.cues, t);
    if (i === this.shown) return;
    this.shown = i;
    const cue = this.cues[i];
    this.srcLine.hidden = !cue;
    this.srcLine.textContent = cue?.text ?? '';
    const tr = this.needsTranslation() ? this.translations.get(i) : undefined;
    this.trLine.hidden = !tr;
    this.trLine.textContent = tr ?? '';
  };

  // ---------- 控制栏按钮 ----------

  private ensureButton() {
    const controls = document.querySelector('#movie_player .ytp-right-controls');
    if (!controls || controls.querySelector('.bilingo-yt-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'ytp-button bilingo-yt-btn';
    btn.innerHTML = LOGO_SVG.replace(/<title>[^<]*<\/title>/, '');
    btn.addEventListener('click', () => this.onToggle?.(!this.enabled));
    controls.prepend(btn);
    this.updateButton();
  }

  /** 由内容脚本入口设置：保存开关状态 */
  onToggle?: (on: boolean) => void;

  private updateButton() {
    const btn = document.querySelector<HTMLButtonElement>('#movie_player .bilingo-yt-btn');
    if (!btn) return;
    const label = this.enabled ? m.yt_button_on() : m.yt_button_off();
    btn.setAttribute('aria-pressed', String(this.enabled));
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
}

// YouTube 双语字幕（内容脚本 / 隔离环境）
// 流程：主环境脚本拦截到播放器的字幕请求（带令牌的网址）→ 这里重新获取 json3 → 拼成句子 →
// 按播放进度分批翻译（当前位置往后约 60 秒，快播完时补下一批，拖动进度时立即翻译新位置）→ 在播放器里叠加显示原文 + 译文。
import LOGO_SVG from '../../assets/logo.svg?raw';
import { m } from '@/shared/i18n';
import type { Settings } from '@/shared/settings';
import { parseJson3, type Json3 } from './captions';
import { SubtitleEngine } from './engine';
import { SubtitleOverlay } from './overlay';

const SOURCE = 'bilingo-yt';
/** 拿不到字幕网址时重新询问的时间点；最终等多久仍拿不到就提示"没有字幕" */
const RETRY_MS = [3000, 6000];
const CAPTIONS_TIMEOUT_MS = 10_000;
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
  private readonly engine: SubtitleEngine;
  private readonly overlay = new SubtitleOverlay('bilingo-yt-subs');
  private raf = 0;
  private timeout = 0;
  private generation = 0;

  constructor(private getSettings: () => Settings) {
    this.engine = new SubtitleEngine(getSettings);
    this.engine.onStatus = (text) => this.overlay.setStatus(text);
  }

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
      if (!this.engine.size && this.enabled) this.setStatus(m.yt_no_captions());
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
      this.engine.setCues(parseJson3(JSON.parse(text) as Json3), u.searchParams.get('lang') ?? '');
      if (!this.engine.size) {
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
    this.engine.reset();
    this.loadedUrl = '';
    document.documentElement.classList.remove('bilingo-yt-on');
    this.overlay.remove();
  }

  // ---------- 渲染 ----------

  private player(): Player | null {
    return document.querySelector<Player>('#movie_player');
  }

  private mount() {
    const player = this.player();
    if (player) this.overlay.mount(player);
  }

  private setStatus(text: string) {
    this.overlay.setStatus(text);
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const player = this.player();
    const video = player?.querySelector<HTMLVideoElement>('video');
    if (!player || !video) return;
    this.mount();
    const ad = player.classList.contains('ad-showing');
    this.overlay.layout(player.clientHeight, !player.classList.contains('ytp-autohide'), ad);
    if (ad) return;
    const frame = this.engine.tick(video.currentTime * 1000);
    if (frame) this.overlay.show(frame);
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

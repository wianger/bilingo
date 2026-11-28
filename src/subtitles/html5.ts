// 其他视频网站的双语字幕：通用的 HTML5 字幕轨道（TextTrack / WebVTT）。
// 不少播放器（原生 <track>、Plyr、hls.js / Shaka 等）会把字幕放进 video.textTracks，扩展可以直接读取：
// 把用户在播放器里选中的轨道设为 hidden（继续加载字幕、但不由浏览器显示），自己显示原文 + 译文。
// 鼠标移到视频上时，右上角出现 Bilingo 按钮用来开关；开关状态全局保存。
import LOGO_SVG from '../../assets/logo.svg?raw';
import { m } from '@/shared/i18n';
import type { Settings } from '@/shared/settings';
import { fromVttCues, type VttCueLike } from './captions';
import { SubtitleEngine } from './engine';
import { SubtitleOverlay } from './overlay';

const SCAN_MS = 1500;
/** 字幕轨道陆续加载（流媒体按片段加载字幕）时，多久检查一次新增的字幕 */
const CUES_MS = 1000;
/** 鼠标离开视频多久后隐藏按钮 */
const BUTTON_HIDE_MS = 2500;

const BUTTON_CSS = `
  .bl-btn { position: absolute; top: 10px; right: 10px; width: 38px; height: 38px; padding: 6px; border: 0;
    border-radius: 10px; background: rgba(20, 20, 24, .62); backdrop-filter: blur(6px); cursor: pointer;
    pointer-events: auto; opacity: 0; transition: opacity .2s; display: grid; place-items: center; }
  .bl-btn.visible { opacity: 1; }
  .bl-btn svg { width: 26px; height: 26px; opacity: .6; filter: grayscale(1); transition: opacity .15s, filter .15s; }
  .bl-btn[aria-pressed="true"] svg { opacity: 1; filter: none; }
  .bl-btn:focus-visible { opacity: 1; outline: 2px solid #8b7cf6; }
`;

/** 常见播放器自己绘制的字幕层：开启双语字幕时隐藏，避免重复显示 */
const PAGE_CSS = `
  html.bilingo-vs-on :is(.vjs-text-track-display, .plyr__captions, .jw-captions, .vp-captions,
    .shaka-text-container, .bmpui-ui-subtitle-overlay, .mejs__captions-layer) { visibility: hidden !important; }
`;

const isSubtitleTrack = (t: TextTrack) => t.kind === 'subtitles' || t.kind === 'captions';

function subtitleTracks(video: HTMLVideoElement): TextTrack[] {
  return [...video.textTracks].filter(isSubtitleTrack);
}

export class VideoSubtitles {
  private video: HTMLVideoElement | null = null;
  private track: TextTrack | null = null;
  /** 我们改动轨道显示方式前的状态，关闭时还原 */
  private restoreMode: TextTrackMode | null = null;
  private cueCount = -1;
  private readonly engine: SubtitleEngine;
  private readonly overlay = new SubtitleOverlay('bilingo-video-subs', '2147483646', BUTTON_CSS);
  private readonly button: HTMLButtonElement;
  private pointerAt = 0;
  private raf = 0;
  private cuesTimer = 0;
  /** 由内容脚本入口设置：保存开关状态 */
  onToggle?: (on: boolean) => void;

  constructor(private readonly getSettings: () => Settings) {
    this.engine = new SubtitleEngine(getSettings);
    this.engine.onStatus = (text) => this.overlay.setStatus(text);
    this.button = document.createElement('button');
    this.button.className = 'bl-btn';
    this.button.innerHTML = LOGO_SVG.replace(/<title>[^<]*<\/title>/, '');
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onToggle?.(!this.enabled);
    });
    this.overlay.shadow.append(this.button);
    // 固定在视频所在位置（每帧更新）；inset 是简写，要先清掉再设置 left/top
    Object.assign(this.overlay.host.style, { position: 'fixed', inset: 'auto' });
  }

  private get enabled() {
    return this.getSettings().videoSubtitles;
  }

  start() {
    const style = document.createElement('style');
    style.textContent = PAGE_CSS;
    (document.head ?? document.documentElement).appendChild(style);
    setInterval(() => this.scan(), SCAN_MS);
    // 鼠标在视频上移动时显示按钮（叠加层本身不接收鼠标事件，不影响播放器操作）
    document.addEventListener(
      'pointermove',
      (e) => {
        const r = this.video?.getBoundingClientRect();
        if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          this.pointerAt = Date.now();
        }
      },
      { passive: true, capture: true },
    );
    this.scan();
  }

  /** 设置变化（开关、翻译服务、目标语言）后调用 */
  refresh() {
    this.updateButton();
    this.detach();
    this.engine.reset();
    if (this.enabled) this.attach();
  }

  /** 找到页面上带字幕轨道、面积最大的可见视频 */
  private scan() {
    let best: HTMLVideoElement | null = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      if (!subtitleTracks(v).length) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width >= 200 && r.height >= 120 && area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    if (best !== this.video) {
      this.detach();
      this.video = best;
      this.engine.reset();
      if (best) {
        cancelAnimationFrame(this.raf);
        this.loop();
        if (this.enabled) this.attach();
      } else {
        this.overlay.remove();
      }
      this.updateButton();
      return;
    }
    if (this.enabled && this.video) this.follow(this.video);
  }

  /**
   * 跟随用户在播放器里的字幕选择：播放器可能把选中的轨道设为 showing（浏览器显示）或 hidden（自己绘制），
   * 关闭字幕时设为 disabled
   */
  private follow(video: HTMLVideoElement) {
    if (this.track?.mode === 'disabled') {
      // 播放器关掉了这条轨道：不再还原它
      this.restoreMode = null;
      this.detach();
    }
    const tracks = subtitleTracks(video);
    const next =
      tracks.find((t) => t !== this.track && t.mode === 'showing') ??
      (this.track ? undefined : tracks.find((t) => t.mode === 'hidden'));
    if (next) {
      this.detach();
      this.attach(next);
    } else if (!this.track) {
      this.overlay.setStatus(m.vs_no_cues());
    }
  }

  /** 开始接管字幕轨道 */
  private attach(preferred?: TextTrack) {
    const video = this.video;
    if (!video) return;
    const tracks = subtitleTracks(video);
    const track = preferred ?? tracks.find((t) => t.mode === 'showing') ?? tracks.find((t) => t.mode === 'hidden');
    if (!track) {
      // 播放器里没有选中字幕：不替用户选语言，提示先打开字幕
      this.overlay.setStatus(m.vs_no_cues());
      return;
    }
    this.overlay.setStatus('');
    this.track = track;
    this.restoreMode = track.mode;
    // hidden：浏览器继续加载字幕、触发事件，但不显示
    track.mode = 'hidden';
    document.documentElement.classList.add('bilingo-vs-on');
    this.cueCount = -1;
    this.readCues();
    this.cuesTimer = window.setInterval(() => this.readCues(), CUES_MS);
  }

  private detach() {
    clearInterval(this.cuesTimer);
    if (this.track && this.restoreMode) this.track.mode = this.restoreMode;
    this.track = null;
    this.restoreMode = null;
    this.overlay.show({});
    this.overlay.setStatus('');
    document.documentElement.classList.remove('bilingo-vs-on');
  }

  private readCues() {
    const cues = this.track?.cues;
    if (!this.track || !cues || cues.length === this.cueCount) return;
    const first = this.cueCount <= 0;
    this.cueCount = cues.length;
    const list: VttCueLike[] = [...cues].map((c) => ({
      startTime: c.startTime,
      endTime: c.endTime,
      text: (c as VTTCue).text ?? '',
    }));
    this.engine.setCues(fromVttCues(list), this.track.language, !first);
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const video = this.video;
    if (!video?.isConnected) return;
    // 全屏时放进全屏元素里，否则固定在视频所在的位置
    const fs = document.fullscreenElement;
    const parent = fs && fs !== video && fs.contains(video) ? fs : document.body;
    this.overlay.mount(parent);
    const r = video.getBoundingClientRect();
    Object.assign(this.overlay.host.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    const hovering = Date.now() - this.pointerAt < BUTTON_HIDE_MS;
    this.button.classList.toggle('visible', hovering || video.paused);
    this.overlay.layout(r.height, hovering, r.width === 0);
    if (!this.track) return;
    const frame = this.engine.tick(video.currentTime * 1000);
    if (frame) this.overlay.show(frame);
  };

  private updateButton() {
    const label = this.enabled ? m.vs_button_on() : m.vs_button_off();
    this.button.setAttribute('aria-pressed', String(this.enabled));
    this.button.setAttribute('aria-label', label);
    this.button.title = label;
  }
}

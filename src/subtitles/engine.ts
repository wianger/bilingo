// 字幕翻译引擎（YouTube 和其他网站的视频共用）：
// 按播放进度分批翻译（当前位置往后约 60 秒，快播完时补下一批，拖动进度时立即翻译新位置），
// 译文按原文文本缓存（字幕陆续加载、重新拼句后仍可复用），翻译失败时提示并稍后重试。
import { m } from '@/shared/i18n';
import { sameLanguage } from '@/shared/langs';
import { batchLimits, type Settings } from '@/shared/settings';
import { translateBatch } from '@/shared/translate-client';
import { cueAt, type Cue } from './captions';

/** 每次往后翻译的时长、提前多久补下一批 */
const WINDOW_MS = 60_000;
const PREFETCH_MS = 40_000;
/** 翻译失败后等多久再重试 */
const RETRY_AFTER_FAILURE_MS = 10_000;

export interface Frame {
  src?: string;
  tr?: string;
}

export class SubtitleEngine {
  private cues: Cue[] = [];
  private sourceLang = '';
  private translations = new Map<string, string>();
  private pending = new Set<string>();
  /** 已经请求翻译到的时间点（毫秒） */
  private horizon = 0;
  /** 翻译失败后，到这个时间之前不再重试 */
  private retryAt = 0;
  private generation = 0;
  private shown = -2;
  /** 翻译失败时的提示；成功后传空字符串 */
  onStatus?: (text: string) => void;

  constructor(private readonly getSettings: () => Settings) {}

  get size() {
    return this.cues.length;
  }

  /** 换一套字幕。keepTranslations：同一轨道陆续加载出更多字幕时保留已有译文 */
  setCues(cues: Cue[], sourceLang = '', keepTranslations = false) {
    if (!keepTranslations) {
      this.generation++;
      this.translations.clear();
      this.pending.clear();
    }
    this.cues = cues;
    this.sourceLang = sourceLang;
    this.horizon = 0;
    this.shown = -2;
  }

  reset() {
    this.setCues([]);
  }

  needsTranslation() {
    return !this.sourceLang || !sameLanguage(this.sourceLang, this.getSettings().targetLang);
  }

  /** 每帧调用：返回需要显示的原文和译文；与上一帧相同时返回 null */
  tick(ms: number): Frame | null {
    const due = ms + PREFETCH_MS > this.horizon || ms < this.horizon - WINDOW_MS * 2;
    if (due && Date.now() >= this.retryAt) {
      if (ms < this.horizon - WINDOW_MS * 2) this.horizon = 0;
      this.translateRange(ms, ms + WINDOW_MS);
    }
    const i = cueAt(this.cues, ms);
    if (i === this.shown) return null;
    this.shown = i;
    const cue = this.cues[i];
    return { src: cue?.text, tr: cue && this.needsTranslation() ? this.translations.get(cue.text) : undefined };
  }

  /** 翻译 [from, to) 时间范围内还没翻译的句子 */
  private translateRange(from: number, to: number) {
    this.horizon = Math.max(this.horizon, to);
    if (!this.needsTranslation()) return;
    const s = this.getSettings();
    const gen = this.generation;
    const texts = [
      ...new Set(
        this.cues
          .filter((c) => c.end > from && c.start < to)
          .map((c) => c.text)
          .filter((t) => !this.translations.has(t) && !this.pending.has(t)),
      ),
    ];
    const { maxChars, maxItems } = batchLimits(s);
    const send = (items: string[]) => {
      items.forEach((t) => this.pending.add(t));
      translateBatch(items, s, this.sourceLang || undefined)
        .then((out) => {
          if (gen !== this.generation) return;
          items.forEach((t, k) => out[k] && this.translations.set(t, out[k]));
          this.shown = -2; // 让当前字幕重新渲染出译文
          this.onStatus?.('');
        })
        .catch((e: unknown) => {
          // 翻译失败要让用户知道（例如没配置 API Key），否则只会看到译文一直不出现；拖动进度或稍后会重试
          if (gen !== this.generation) return;
          this.onStatus?.(m.translate_failed({ msg: (e as Error).message || String(e) }));
          this.horizon = 0;
          this.retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
        })
        .finally(() => items.forEach((t) => this.pending.delete(t)));
    };
    let batch: string[] = [];
    let chars = 0;
    for (const t of texts) {
      if (batch.length && (chars + t.length > maxChars || batch.length >= maxItems)) {
        send(batch);
        batch = [];
        chars = 0;
      }
      batch.push(t);
      chars += t.length;
    }
    if (batch.length) send(batch);
  }
}

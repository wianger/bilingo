import type { SiteRule } from './site-rules';
import { storage } from 'wxt/utils/storage';

export type ProviderId = 'builtin' | 'local' | 'google' | 'azure' | 'deepl' | 'openai';
export type TranslationStyle = 'plain' | 'faded' | 'underline' | 'highlight' | 'quote';
/** smart：只译正文，跳过导航、菜单、按钮、页眉页脚等界面元素；all：页面上所有文字 */
export type TranslateScope = 'smart' | 'all';
/** PDF 阅读器的显示方式：原文和译文并排 / 只看译文 / 只看原文 */
export type PdfMode = 'dual' | 'translation' | 'original';

export interface OpenAISettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** null 表示不传 temperature（部分推理模型不接受该参数） */
  temperature: number | null;
  /** 追加到系统提示词后的额外要求（术语表、语气等） */
  prompt: string;
  maxBatchChars: number;
  maxBatchItems: number;
  concurrency: number;
}

export interface Settings {
  /** 界面语言：auto 跟随浏览器 */
  uiLang: 'auto' | 'en' | 'zh-CN';
  provider: ProviderId;
  targetLang: string;
  style: TranslationStyle;
  scope: TranslateScope;
  floatBall: boolean;
  /** YouTube 双语字幕 */
  ytSubtitles: boolean;
  /** PDF：在线 PDF 自动用 Bilingo 阅读器打开；阅读器的显示方式 */
  pdf: { autoOpen: boolean; mode: PdfMode };
  autoSites: string[];
  openai: OpenAISettings;
  azure: { key: string; region: string };
  deepl: { key: string };
  /** 用户的网站规则 */
  siteRules: SiteRule[];
  /** 停用的内置网站规则 id */
  disabledBuiltinRules: string[];
  /** 本地大模型（Transformers.js + WebGPU） */
  local: { model: string; host: string };
}

export const DEFAULT_SETTINGS: Settings = {
  uiLang: 'auto',
  provider: 'builtin',
  targetLang: 'zh-CN',
  style: 'faded',
  scope: 'smart',
  floatBall: true,
  ytSubtitles: false,
  pdf: { autoOpen: false, mode: 'dual' },
  autoSites: [],
  siteRules: [],
  disabledBuiltinRules: [],
  openai: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    prompt: '',
    // 参考 Read Frog 的实践：小批次能显著降低大模型输出格式出错的概率
    maxBatchChars: 1200,
    maxBatchItems: 6,
    concurrency: 3,
  },
  azure: { key: '', region: '' },
  deepl: { key: '' },
  local: { model: 'drnfns/Hy-MT2-1.8B-ONNX', host: 'https://hf-mirror.com/' },
};

/** 翻译服务的批量参数（展示文字见 src/ui/labels.ts） */
export interface ProviderMeta {
  /** 每批最大字符数 / 段数（openai 以用户设置为准） */
  maxChars: number;
  maxItems: number;
  concurrency: number;
  /** 是否在内容脚本里本地执行（不经过后台） */
  local?: boolean;
}

export const PROVIDERS_META: Record<ProviderId, ProviderMeta> = {
  builtin: {
    maxChars: 4000,
    maxItems: 30,
    concurrency: 4,
    local: true,
  },
  local: {
    maxChars: 2000,
    maxItems: 8,
    concurrency: 1,
  },
  google: {
    maxChars: 3000,
    maxItems: 20,
    concurrency: 6,
  },
  azure: {
    maxChars: 5000,
    maxItems: 50,
    concurrency: 4,
  },
  deepl: {
    maxChars: 5000,
    maxItems: 50,
    concurrency: 3,
  },
  openai: {
    maxChars: 1200,
    maxItems: 6,
    concurrency: 3,
  },
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};
export type SettingsPatch = DeepPartial<Settings>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeSettings(out[k], v) : v;
  }
  return out as T;
}

export const settingsItem = storage.defineItem<SettingsPatch>('local:settings', { fallback: {} });

export async function getSettings(): Promise<Settings> {
  return mergeSettings(DEFAULT_SETTINGS, await settingsItem.getValue());
}

export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const next = mergeSettings(await getSettings(), patch);
  await settingsItem.setValue(next);
  return next;
}

export function watchSettings(cb: (s: Settings) => void): () => void {
  return settingsItem.watch((v) => cb(mergeSettings(DEFAULT_SETTINGS, v)));
}

export function batchLimits(s: Settings): { maxChars: number; maxItems: number } {
  if (s.provider === 'openai') {
    return { maxChars: s.openai.maxBatchChars || 1200, maxItems: s.openai.maxBatchItems || 6 };
  }
  const m = PROVIDERS_META[s.provider];
  return { maxChars: m.maxChars, maxItems: m.maxItems };
}

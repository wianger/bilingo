import { storage } from 'wxt/utils/storage';

export type ProviderId = 'builtin' | 'local' | 'google' | 'azure' | 'deepl' | 'openai';
export type TranslationStyle = 'plain' | 'faded' | 'underline' | 'highlight' | 'quote';

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
  provider: ProviderId;
  targetLang: string;
  style: TranslationStyle;
  floatBall: boolean;
  autoSites: string[];
  openai: OpenAISettings;
  azure: { key: string; region: string };
  deepl: { key: string };
  /** 本地大模型（Transformers.js + WebGPU） */
  local: { model: string; host: string };
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'builtin',
  targetLang: 'zh-CN',
  style: 'faded',
  floatBall: true,
  autoSites: [],
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

export interface ProviderMeta {
  name: string;
  /** 卡片上的短标签 */
  tags: string[];
  /** 一句话说明 */
  desc: string;
  /** 每批最大字符数 / 段数（openai 以用户设置为准） */
  maxChars: number;
  maxItems: number;
  concurrency: number;
  /** 是否在内容脚本里本地执行（不经过后台） */
  local?: boolean;
}

export const PROVIDERS_META: Record<ProviderId, ProviderMeta> = {
  builtin: {
    name: '浏览器内置翻译',
    tags: ['免费', '本机运行'],
    desc: 'Chrome / Edge 自带的离线翻译模型，文本不出本机',
    maxChars: 4000,
    maxItems: 30,
    concurrency: 4,
    local: true,
  },
  local: {
    name: '本地大模型 Hy-MT2',
    tags: ['免费', '离线', '需显卡'],
    desc: '在你的显卡上运行腾讯开源翻译模型，质量更好',
    maxChars: 2000,
    maxItems: 8,
    concurrency: 1,
  },
  google: {
    name: '谷歌翻译',
    tags: ['免费'],
    desc: '速度快，需要能访问谷歌',
    maxChars: 3000,
    maxItems: 20,
    concurrency: 6,
  },
  azure: {
    name: 'Azure 翻译',
    tags: ['每月 200 万字符免费'],
    desc: '微软云翻译，需要 Azure 密钥',
    maxChars: 5000,
    maxItems: 50,
    concurrency: 4,
  },
  deepl: {
    name: 'DeepL',
    tags: ['API Free 额度'],
    desc: '欧洲语言质量出色，需要 DeepL 密钥',
    maxChars: 5000,
    maxItems: 50,
    concurrency: 3,
  },
  openai: {
    name: 'AI 大模型',
    tags: ['OpenAI 兼容'],
    desc: 'DeepSeek、通义、GLM、Ollama 等任意兼容接口',
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

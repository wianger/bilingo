import { m, setUiLang } from '@/shared/i18n';
import {
  DEFAULT_SETTINGS,
  getSettings,
  mergeSettings,
  PROVIDERS_META,
  type ProviderId,
  type Settings,
  type SettingsPatch,
} from '@/shared/settings';
import { cacheGetMany, cachePutMany, hashKey } from './cache';
import { Limiter, TranslateError, withRetry } from './http';
import { translateLocal } from './providers/local';
import { translateAzure, translateDeepL, translateGoogle } from './providers/machine';
import { translateOpenAI } from './providers/openai';

type Provider = (texts: string[], s: Settings) => Promise<string[]>;

const PROVIDERS: Partial<Record<ProviderId, Provider>> = {
  local: translateLocal,
  google: translateGoogle,
  azure: translateAzure,
  deepl: translateDeepL,
  openai: translateOpenAI,
};

const limiters = new Map<ProviderId, Limiter>();

function limiterFor(s: Settings): Limiter {
  const limit = s.provider === 'openai' ? s.openai.concurrency || 3 : PROVIDERS_META[s.provider].concurrency;
  let l = limiters.get(s.provider);
  if (!l) limiters.set(s.provider, (l = new Limiter(limit)));
  l.limit = limit;
  return l;
}

/** 缓存键包含会影响译文的配置：服务、模型、提示词、目标语言 */
function cacheScope(s: Settings): string[] {
  const extra =
    s.provider === 'openai'
      ? [s.openai.baseUrl, s.openai.model, s.openai.prompt]
      : s.provider === 'local'
        ? [s.local.model]
        : [];
  return [s.provider, ...extra, s.targetLang];
}

export async function translateTexts(texts: string[], override?: SettingsPatch): Promise<string[]> {
  const s = override ? mergeSettings(DEFAULT_SETTINGS, override) : await getSettings();
  setUiLang(s.uiLang); // service worker 冷启动时，错误信息也用正确的界面语言
  const provider = PROVIDERS[s.provider];
  if (!provider) throw new TranslateError(m.err_not_background({ id: s.provider }));

  const useCache = !override; // 设置页"测试"不读写缓存
  const keys = useCache ? await Promise.all(texts.map((t) => hashKey([...cacheScope(s), t]))) : [];
  const result: (string | undefined)[] = useCache ? await cacheGetMany(keys) : texts.map(() => undefined);

  const missing = result.flatMap((r, i) => (r === undefined ? [i] : []));
  if (!missing.length) return result as string[];

  const out = await limiterFor(s).run(() =>
    withRetry(() =>
      provider(
        missing.map((i) => texts[i]!),
        s,
      ),
    ),
  );
  const fresh: [string, string][] = [];
  missing.forEach((i, j) => {
    result[i] = out[j] ?? '';
    const v = out[j];
    if (useCache && v) fresh.push([keys[i]!, v]);
  });
  await cachePutMany(fresh).catch(() => {});
  return result as string[];
}

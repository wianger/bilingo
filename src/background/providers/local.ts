// 本地大模型（Hy-MT2 + WebGPU），实际推理在 offscreen 文档的 Worker 中进行
import { uiLocale } from '@/shared/i18n';
import { m } from '@/shared/i18n';
import { canUseFrame, frameApi, removeFrame } from '@/local-llm/frame';
import { findPreset, formatOf } from '@/local-llm/models';
import type { LocalModelConfig } from '@/local-llm/protocol';
import { sendMessage } from '@/shared/messaging';
import type { Settings } from '@/shared/settings';
import { TranslateError } from '../http';

const OFFSCREEN_URL = '/offscreen.html';
let creating: Promise<void> | null = null;

function hasOffscreen(): boolean {
  return typeof browser.offscreen?.createDocument === 'function';
}

/** 没有 offscreen API、但后台是有 DOM 的页面（Safari）：用隐藏 iframe 托管同一个页面 */
const useFrame = () => !hasOffscreen() && canUseFrame();

export async function ensureOffscreen(): Promise<void> {
  if (!hasOffscreen()) {
    throw new TranslateError(m.err_no_offscreen());
  }
  const contexts = await browser.runtime.getContexts({
    contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length) return;
  creating ??= browser.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [browser.offscreen.Reason.WORKERS],
      justification: 'Run an on-device translation model in a Web Worker with WebGPU',
    })
    .finally(() => (creating = null));
  await creating;
}

export async function closeOffscreen(): Promise<void> {
  if (useFrame()) return removeFrame();
  if (!hasOffscreen()) return;
  await browser.offscreen.closeDocument().catch(() => {});
}

export function localConfig(s: Settings): LocalModelConfig {
  const model = s.local.model.trim();
  return { model, host: s.local.host, format: formatOf(model), dtype: findPreset(model)?.dtype, locale: uiLocale() };
}

/** 用浏览器自带的 CLD3 识别原文语言（TranslateGemma 需要知道原文语言） */
async function detectSource(text: string): Promise<string | undefined> {
  try {
    const r = await browser.i18n.detectLanguage(text);
    const top = r.languages.sort((a, b) => b.percentage - a.percentage)[0];
    return top && top.language !== 'und' ? top.language : undefined;
  } catch {
    return undefined;
  }
}

export async function prepareLocal(s: Settings): Promise<void> {
  if (useFrame()) return (await frameApi(browser.runtime.getURL(OFFSCREEN_URL))).load(localConfig(s));
  await ensureOffscreen();
  await sendMessage('llmLoad', { config: localConfig(s) });
}

export async function translateLocal(texts: string[], s: Settings): Promise<string[]> {
  const config = localConfig(s);
  const sourceLangs =
    config.format === 'translategemma'
      ? await Promise.all(texts.map(async (t) => (await detectSource(t)) ?? ''))
      : undefined;
  if (useFrame()) {
    const api = await frameApi(browser.runtime.getURL(OFFSCREEN_URL));
    return api.translate(config, texts, s.targetLang, sourceLangs);
  }
  await ensureOffscreen();
  return sendMessage('llmTranslate', { config, texts, targetLang: s.targetLang, sourceLangs });
}

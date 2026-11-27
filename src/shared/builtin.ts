// 浏览器内置 AI：Translator API + Language Detector API（Chrome 138+ / Edge 148+，桌面端，本地模型）
// 文档：https://developer.chrome.com/docs/ai/translator-api
// 只能在窗口上下文调用（内容脚本、扩展页面），不能在 service worker 里用。
import { sameLanguage, toBuiltinCode } from './langs';

export const hasBuiltinTranslator = () => typeof self !== 'undefined' && 'Translator' in self;
export const hasBuiltinDetector = () => typeof self !== 'undefined' && 'LanguageDetector' in self;

let detectorPromise: Promise<LanguageDetector> | null = null;

async function getDetector(): Promise<LanguageDetector | null> {
  if (!hasBuiltinDetector()) return null;
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const a = await LanguageDetector.availability();
      if (a === 'unavailable') throw new Error('unavailable');
      return LanguageDetector.create();
    })();
    detectorPromise.catch(() => (detectorPromise = null));
  }
  try {
    return await detectorPromise;
  } catch {
    return null;
  }
}

/** 检测语言，返回 BCP 47 代码；不可用或置信度太低时返回 undefined */
export async function detectLanguage(text: string): Promise<string | undefined> {
  const d = await getDetector();
  if (!d) return undefined;
  try {
    const [top] = await d.detect(text.slice(0, 1000));
    if (top && top.detectedLanguage !== 'und' && (top.confidence ?? 0) >= 0.5) return top.detectedLanguage;
  } catch {}
  return undefined;
}

const translators = new Map<string, Promise<Translator>>();

export type DownloadProgress = (loaded: number) => void;

export async function builtinAvailability(source: string, target: string): Promise<Availability | 'unsupported'> {
  if (!hasBuiltinTranslator()) return 'unsupported';
  return Translator.availability({ sourceLanguage: source, targetLanguage: toBuiltinCode(target) });
}

/** 获取（必要时创建/下载）某个语言对的翻译器。语言包需下载时，create() 必须由用户点击触发。 */
export function getTranslator(source: string, target: string, onProgress?: DownloadProgress): Promise<Translator> {
  const tgt = toBuiltinCode(target);
  const key = `${source}>${tgt}`;
  let p = translators.get(key);
  if (!p) {
    p = (async () => {
      const opts = { sourceLanguage: source, targetLanguage: tgt };
      const a = await Translator.availability(opts);
      if (a === 'unavailable') throw new Error(`浏览器内置翻译不支持 ${source} → ${tgt}`);
      try {
        return await Translator.create({
          ...opts,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded));
          },
        });
      } catch (e) {
        if ((e as DOMException).name === 'NotAllowedError') {
          throw new Error(
            `${source} → ${tgt} 的语言包尚未下载。请点击网页上的 Bilingo 悬浮按钮重试，或在扩展设置页点击“下载”。`,
            { cause: e },
          );
        }
        throw e;
      }
    })();
    translators.set(key, p);
    p.catch(() => translators.delete(key));
  }
  return p;
}

/**
 * 用内置模型翻译一批文本。每段先检测语言，已是目标语言的原样返回。
 * sourceHint：检测失败时使用的源语言（通常取页面 <html lang>）。
 */
export async function translateBuiltin(texts: string[], target: string, sourceHint = 'en'): Promise<string[]> {
  if (!hasBuiltinTranslator()) {
    throw new Error('当前浏览器不支持内置 AI 翻译（需要桌面版 Chrome 138+ 或 Edge 148+），请在设置中换一个翻译服务');
  }
  return Promise.all(
    texts.map(async (text) => {
      const src = (await detectLanguage(text)) ?? sourceHint;
      if (sameLanguage(src, target)) return text;
      const t = await getTranslator(src, target);
      return t.translate(text);
    }),
  );
}

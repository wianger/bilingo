// 内容脚本发起翻译：内置 AI 翻译只能在页面里运行，其余服务都经由后台
import { translateBuiltin } from './builtin';
import { sendMessage } from './messaging';
import type { Settings } from './settings';

export async function translateBatch(texts: string[], s: Settings, sourceLang?: string): Promise<string[]> {
  if (s.provider === 'builtin') {
    return translateBuiltin(texts, s.targetLang, sourceLang ?? (document.documentElement.lang || 'en'));
  }
  return sendMessage('translate', { texts });
}

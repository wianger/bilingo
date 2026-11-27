// Hy-MT2 官方推荐的翻译指令模板（见 https://huggingface.co/tencent/Hy-MT2-1.8B）
// 目标语言为中文时使用中文模板 + 中文语言名，否则使用英文模板 + 英文语言名。
import { langEnglishName } from '@/shared/langs';
import { toTranslateGemmaCode, type PromptFormat } from './models';

export type ChatMessage = { role: 'user'; content: string | Record<string, string>[] };

const ZH_NAMES: Record<string, string> = {
  'zh-CN': '中文',
  'zh-TW': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  pt: '葡萄牙语',
  it: '意大利语',
  ru: '俄语',
  ar: '阿拉伯语',
  vi: '越南语',
  th: '泰语',
  id: '印尼语',
};

export function buildPrompt(text: string, targetLang: string): string {
  if (targetLang.startsWith('zh')) {
    return `将以下文本翻译为${ZH_NAMES[targetLang] ?? '中文'}，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}`;
  }
  return (
    `Translate the following text into ${langEnglishName(targetLang)}. ` +
    `Note that you should only output the translated result without any additional explanation:\n\n${text}`
  );
}

/** 按模型的提示词格式构造对话消息 */
export function buildMessages(
  format: PromptFormat,
  text: string,
  targetLang: string,
  sourceLang?: string,
): ChatMessage[] {
  if (format === 'translategemma') {
    // TranslateGemma 的聊天模板要求结构化内容，并且必须给出原文语言
    const target = toTranslateGemmaCode(targetLang) ?? 'en';
    const source = (sourceLang && toTranslateGemmaCode(sourceLang)) || 'en';
    return [{ role: 'user', content: [{ type: 'text', source_lang_code: source, target_lang_code: target, text }] }];
  }
  return [{ role: 'user', content: buildPrompt(text, targetLang) }];
}

/** 生成长度上限：译文 token 数与原文字符数大致同量级，留足余量 */
export function maxNewTokens(text: string): number {
  return Math.min(2048, Math.max(64, Math.ceil(text.length * 2.5)));
}

export function cleanOutput(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

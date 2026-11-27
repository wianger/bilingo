export interface Lang {
  /** 内部代码（也用于谷歌翻译） */
  code: string;
  /** 本地名称 */
  name: string;
  /** 英文名，给大模型提示词用 */
  en: string;
}

export const LANGS: Lang[] = [
  { code: 'zh-CN', name: '简体中文', en: 'Simplified Chinese' },
  { code: 'zh-TW', name: '繁體中文', en: 'Traditional Chinese' },
  { code: 'en', name: 'English', en: 'English' },
  { code: 'ja', name: '日本語', en: 'Japanese' },
  { code: 'ko', name: '한국어', en: 'Korean' },
  { code: 'fr', name: 'Français', en: 'French' },
  { code: 'de', name: 'Deutsch', en: 'German' },
  { code: 'es', name: 'Español', en: 'Spanish' },
  { code: 'pt', name: 'Português', en: 'Portuguese' },
  { code: 'it', name: 'Italiano', en: 'Italian' },
  { code: 'ru', name: 'Русский', en: 'Russian' },
  { code: 'ar', name: 'العربية', en: 'Arabic' },
  { code: 'vi', name: 'Tiếng Việt', en: 'Vietnamese' },
  { code: 'th', name: 'ไทย', en: 'Thai' },
  { code: 'id', name: 'Bahasa Indonesia', en: 'Indonesian' },
];

export function langEnglishName(code: string): string {
  return LANGS.find((l) => l.code === code)?.en ?? code;
}

/** 浏览器内置 Translator API 使用 BCP 47 代码 */
export function toBuiltinCode(code: string): string {
  if (code === 'zh-CN') return 'zh';
  if (code === 'zh-TW') return 'zh-Hant';
  return code;
}

export function toAzureCode(code: string): string {
  if (code === 'zh-CN') return 'zh-Hans';
  if (code === 'zh-TW') return 'zh-Hant';
  return code;
}

export function toDeepLCode(code: string): string {
  const map: Record<string, string> = { 'zh-CN': 'ZH-HANS', 'zh-TW': 'ZH-HANT', en: 'EN-US', pt: 'PT-BR' };
  return map[code] ?? code.toUpperCase();
}

/** 只比较主语言部分：zh-Hans / zh-CN / zh → zh（但区分简繁） */
export function sameLanguage(detected: string, target: string): boolean {
  const norm = (c: string) => {
    const lower = c.toLowerCase();
    if (lower === 'zh-tw' || lower === 'zh-hant' || lower === 'zh-hk') return 'zh-hant';
    return lower.split('-')[0];
  };
  return norm(detected) === norm(target);
}

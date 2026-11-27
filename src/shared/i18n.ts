// 界面语言：由设置里的 uiLang 决定（auto 跟随浏览器语言），Paraglide 的消息函数通过 overwriteGetLocale 读取。
// 不用浏览器原生的 chrome.i18n：它只能跟随浏览器语言，无法在扩展内切换（WXT 文档也说明了这一限制）。
import { baseLocale, isLocale, overwriteGetLocale, type Locale } from '@/paraglide/runtime';

export { m } from '@/paraglide/messages';
export type { Locale };

export type UiLang = 'auto' | Locale;

/** 把浏览器语言映射到我们支持的界面语言：中文（含繁体）→ zh-CN，其余 → 英文 */
export function resolveLocale(pref: UiLang, browserLang = globalThis.navigator?.language ?? ''): Locale {
  if (pref !== 'auto' && isLocale(pref)) return pref;
  return browserLang.toLowerCase().startsWith('zh') ? 'zh-CN' : baseLocale;
}

let current: Locale = resolveLocale('auto');
overwriteGetLocale(() => current);

/** 切换界面语言，返回是否发生了变化（调用方据此刷新界面） */
export function setUiLang(pref: UiLang): boolean {
  const next = resolveLocale(pref);
  if (next === current) return false;
  current = next;
  return true;
}

export function uiLocale(): Locale {
  return current;
}

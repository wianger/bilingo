import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import zh from '../../messages/zh-CN.json';
import { m, resolveLocale, setUiLang } from '@/shared/i18n';

const keys = (o: Record<string, string>) =>
  Object.keys(o)
    .filter((k) => k !== '$schema')
    .sort();
const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();

describe('interface translations', () => {
  it('English and Chinese have exactly the same messages', () => {
    expect(keys(zh)).toEqual(keys(en));
  });

  it('every message uses the same placeholders in both languages', () => {
    for (const k of keys(en)) {
      expect(params((zh as Record<string, string>)[k]!), k).toEqual(params((en as Record<string, string>)[k]!));
    }
  });

  it('messages are compiled and follow the selected language', () => {
    setUiLang('en');
    expect(m.popup_translate_page()).toBe('Translate this page');
    setUiLang('zh-CN');
    expect(m.popup_translate_page()).toBe('翻译此页面');
    expect(m.local_deleted({ n: 3, repo: 'a/b' })).toBe('已删除 a/b 的 3 个文件');
    setUiLang('en');
  });

  it('"auto" follows the browser language', () => {
    expect(resolveLocale('auto', 'zh-TW')).toBe('zh-CN');
    expect(resolveLocale('auto', 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale('auto', 'en-US')).toBe('en');
    expect(resolveLocale('auto', 'ja')).toBe('en');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
  });
});

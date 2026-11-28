// 按网站的翻译规则：修正自动识别在个别网站上的失误。
// 设计参考沉浸式翻译（JSON 规则）、Read Frog（内置 + 用户规则，可单独停用内置规则）、Kiss Translator（网页上点选生成规则），
// 只保留三家共同的核心字段。

export interface SiteRule {
  /** 唯一 id。内置规则以 "builtin:" 开头 */
  id: string;
  /** 适用的网址：example.com（含子域名）、*.example.com、example.com/path*；多个任一匹配即可 */
  matches: string[];
  /** 只翻译这些区域（CSS 选择器）。设置后不再自动识别正文 */
  include?: string[];
  /** 不翻译这些区域（CSS 选择器） */
  exclude?: string[];
  /** 翻译开启时注入的 CSS，用于修复布局（例如解除标题的行数截断） */
  css?: string;
  /** 说明（展示用） */
  note?: string;
}

/** 某个网址最终生效的规则（多条规则合并后） */
export interface ResolvedRules {
  ids: string[];
  include: string[];
  exclude: string[];
  css: string;
}

/**
 * 内置规则：只收录在真实网站上验证过、确实有改善的规则。
 * 网站改版后可能失效，用户可在设置中单独停用。
 * （曾验证过 YouTube 标题的行数截断规则：当前版本的 YouTube 不需要，已移除。）
 */
export const BUILTIN_RULES: SiteRule[] = [];

/** 网址是否匹配一个模式（不区分大小写，忽略协议、端口、查询参数） */
export function matchesPattern(url: URL, pattern: string): boolean {
  let p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p === '*') return url.protocol === 'http:' || url.protocol === 'https:';
  p = p.replace(/^[a-z]+:\/\//, '');
  const slash = p.indexOf('/');
  const hostPat = slash < 0 ? p : p.slice(0, slash);
  const pathPat = slash < 0 ? '' : p.slice(slash);
  const host = url.hostname.toLowerCase();

  const bare = hostPat.replace(/^\*\./, '');
  // example.com 与 *.example.com 都匹配主域名和所有子域名
  if (host !== bare && !host.endsWith(`.${bare}`)) return false;
  if (!pathPat) return true;
  const re = new RegExp(`^${pathPat.split('*').map(escapeRegExp).join('.*')}$`);
  return re.test(url.pathname.toLowerCase());
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 合并所有匹配当前网址的规则：数组取并集，CSS 依次拼接；内置规则在前，用户规则在后 */
export function resolveRules(
  url: URL,
  userRules: SiteRule[],
  disabledBuiltins: string[],
  builtins: SiteRule[] = BUILTIN_RULES,
): ResolvedRules {
  const out: ResolvedRules = { ids: [], include: [], exclude: [], css: '' };
  const rules = [...builtins.filter((r) => !disabledBuiltins.includes(r.id)), ...userRules];
  for (const r of rules) {
    if (!r.matches.some((p) => matchesPattern(url, p))) continue;
    out.ids.push(r.id);
    out.include.push(...validSelectors(r.include));
    out.exclude.push(...validSelectors(r.exclude));
    if (r.css?.trim()) out.css += `${r.css.trim()}\n`;
  }
  out.include = [...new Set(out.include)];
  out.exclude = [...new Set(out.exclude)];
  return out;
}

/** 丢弃写错的选择器，避免一条错误规则让整个页面的翻译失败 */
export function validSelectors(list: string[] | undefined): string[] {
  return (list ?? []).map((s) => s.trim()).filter((s) => s && isValidSelector(s));
}

export function isValidSelector(s: string): boolean {
  try {
    document.createDocumentFragment().querySelector(s);
    return true;
  } catch {
    return false;
  }
}

/** 规则里的网站名（展示用） */
export function ruleHost(r: SiteRule): string {
  return r.matches[0] ?? '';
}

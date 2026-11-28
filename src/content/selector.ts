// 为网页上点选的元素生成 CSS 选择器，用于网站规则。
// 与 @medv/finder 等"在当前页面唯一"的生成器不同，这里追求的是"在同一网站的其他页面上也能匹配到同类区域"：
// 不用 nth-child，跳过打包工具生成的哈希类名，优先使用 data-testid、itemprop、语义化的 id 和类名。

const OWN = /^bilingo-/;

/** 类名是否稳定（不是 CSS Modules / styled-components / emotion 等生成的哈希名） */
export function isStableClass(c: string): boolean {
  if (!c || c.length > 40 || OWN.test(c)) return false;
  if (/^(css|sc|jsx|svelte|emotion|tw|astro|vue)-/i.test(c)) return false;
  if (/\d{3,}/.test(c)) return false;
  // 哈希后缀：sidebar__oqw6Y8、Button-ButtonBase-9n-Xk、title_1x2y3 —— 末尾几个字符里数字和字母混在一起。
  // col-md-6、mt-4 这类工具类也会被排除，它们本来就不适合用来定位网站的某块区域
  const tail = c.slice(-5);
  if (/\d/.test(tail) && /[A-Za-z]/.test(tail)) return false;
  if (/^[a-z]{1,3}[A-Z0-9][A-Za-z0-9]{3,}$/.test(c)) return false; // aBcD12 一类
  return /^[A-Za-z_-][\w-]*$/.test(c);
}

export function isStableId(id: string): boolean {
  return /^[A-Za-z][\w-]*$/.test(id) && !/\d{2,}/.test(id) && id.length <= 40 && !OWN.test(id);
}

const STABLE_ATTRS = ['data-testid', 'data-test', 'data-qa', 'itemprop', 'role'];

/** 单个元素的描述：有稳定特征时返回如 "aside.sidebar"、"div[data-testid=\"comments\"]"，否则 null */
export function describe(el: Element): string | null {
  const tag = el.localName;
  if (el.id && isStableId(el.id)) return `${tag}#${CSS.escape(el.id)}`;
  for (const a of STABLE_ATTRS) {
    const v = el.getAttribute(a);
    if (v && v.length <= 40 && !/\d{3,}/.test(v)) return `${tag}[${a}="${v.replace(/"/g, '\\"')}"]`;
  }
  const classes = [...el.classList].filter(isStableClass).slice(0, 2);
  if (classes.length) return tag + classes.map((c) => `.${CSS.escape(c)}`).join('');
  return null;
}

/** 语义化标签本身就足够明确，可以单独作为选择器 */
const SEMANTIC_TAGS = new Set(['aside', 'nav', 'header', 'footer', 'main', 'article', 'section', 'form', 'table']);

/**
 * 生成选择器：元素自身有稳定特征就用它；否则加上最近的、有稳定特征的祖先作为限定。
 * 结果在同类页面上通常能匹配到同一类区域。
 */
export function selectorFor(el: Element, root: ParentNode = document): string {
  const own = describe(el);
  if (own) return own;
  const tag = el.localName;
  for (let p = el.parentElement, depth = 0; p && p.localName !== 'body' && depth < 6; p = p.parentElement, depth++) {
    const d = describe(p) ?? (SEMANTIC_TAGS.has(p.localName) ? p.localName : null);
    if (d) {
      const sel = `${d} ${tag}`;
      if (root.querySelectorAll(sel).length) return sel;
    }
  }
  return SEMANTIC_TAGS.has(tag) ? tag : `body ${tag}`;
}

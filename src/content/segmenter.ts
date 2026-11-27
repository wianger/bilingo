// 段落识别：找出页面里"最小的块级文本容器"作为翻译单元

export const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'PRE',
  'CODE',
  'KBD',
  'SAMP',
  'VAR',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'SVG',
  'MATH',
  'CANVAS',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'VIDEO',
  'AUDIO',
  'IMG',
  'PICTURE',
  'HEAD',
]);

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HGROUP',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'THEAD',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'UL',
  'CAPTION',
  'SUMMARY',
  'MENU',
]);

const INLINE_TAGS = new Set([
  'A',
  'ABBR',
  'B',
  'BDI',
  'BDO',
  'CITE',
  'CODE',
  'DATA',
  'DFN',
  'EM',
  'FONT',
  'I',
  'KBD',
  'LABEL',
  'MARK',
  'Q',
  'RUBY',
  'S',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TIME',
  'U',
  'BR',
  'WBR',
  'IMG',
  'SVG',
]);

const BLOCK_SELECTOR = [...BLOCK_TAGS].map((t) => t.toLowerCase()).join(',');

/** 插件自己插入的节点 */
export const OWN_CLASSES = ['bilingo-tr', 'bilingo-loading', 'bilingo-error', 'bilingo-wrap'];
export const HOST_ID = 'bilingo-host';
export const STATE_ATTR = 'data-bilingo';

/** 这些祖先之内的内容不翻译 */
export const SKIP_CONTEXT = [
  'pre',
  'code',
  'textarea',
  'script',
  'style',
  'svg',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '.notranslate',
  '[translate="no"]',
  `.${OWN_CLASSES[0]}`,
  `#${HOST_ID}`,
].join(',');

const tagOf = (el: Element) => el.tagName.toUpperCase();

/** 网页的界面部分（智能模式下不翻译）：导航、菜单、工具栏、标签页、按钮、搜索框等 */
const UI_CONTEXT = [
  'nav',
  'button',
  'select',
  '[role="navigation"]',
  '[role="menubar"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="toolbar"]',
  '[role="tablist"]',
  '[role="tab"]',
  '[role="button"]',
  '[role="search"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="tooltip"]',
].join(',');

/** 页面级的页眉 / 页脚（文章自己的 <header>、<footer> 属于正文，照常翻译） */
function isPageChrome(el: Element): boolean {
  const hf = el.closest('header, footer');
  return !!hf && !hf.closest('article, main, [role="main"]');
}

/** 画成"控件 / 标签"外观的元素：flex / inline-block 等盒子，并且有边框或背景色 */
function looksLikeControl(el: Element): boolean {
  const st = getComputedStyle(el);
  if (!/^(inline-)?(flex|block|grid)$|^inline-block$/.test(st.display)) return false;
  const bg = st.backgroundColor;
  const hasBg = bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg);
  return hasBg || parseFloat(st.borderTopWidth) > 0 || parseFloat(st.borderBottomWidth) > 0;
}

/**
 * 智能模式下，按内容和外观判断"界面文字"：
 * - 用链接做的按钮、徽章、标签胶囊（短文本 + 控件外观）
 * - 链接里的单个小写单词：话题标签、文件夹名、用户名等
 */
export function isUiText(el: Element, text: string): boolean {
  if (/^H[1-6]$/.test(tagOf(el))) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  const link = el.closest('a') ?? (el.querySelectorAll('a').length === 1 ? el.querySelector('a') : null);
  const inLink = !!link && (link.textContent ?? '').trim() === text.trim();
  if (inLink && words === 1 && /^[a-z0-9][a-z0-9._-]*$/.test(text.trim())) return true;
  // 链接密度（Readability 的导航判断法）：多个各自独立的短链接占了大部分文字 → 菜单、面包屑、
  // "N points by X | N comments" 一类元信息。紧挨着、中间没有任何字符的链接是被拆开的一句话（如 GitHub 的提交说明），不算
  const links = [...el.querySelectorAll('a')];
  if (links.length >= 3) {
    const linkTexts = links.map((a) => (a.textContent ?? '').trim());
    const linkChars = linkTexts.reduce((n, t) => n + t.length, 0);
    const short = linkTexts.every((t) => t.split(/\s+/).length <= 3);
    const gaps = links.slice(1).filter((a, i) => {
      const r = document.createRange();
      r.setStartAfter(links[i]!);
      r.setEndBefore(a);
      return r.toString().length > 0;
    }).length;
    // 大多数链接之间有间隔（空格、分隔符）才是列表；被拆开的一句话里链接是首尾相接的
    const separated = gaps >= (links.length - 1) / 2;
    if (short && separated && linkChars / text.length > 0.5) return true;
  }
  if (words > 3 || text.length > 30) return false;
  if (inLink && (looksLikeControl(link) || [...link.querySelectorAll('*')].some(looksLikeControl))) return true;
  return words <= 2 && looksLikeControl(el);
}

/** 智能模式：是否属于网页界面而非正文 */
export function isUiChrome(el: Element): boolean {
  return !!el.closest(UI_CONTEXT) || isPageChrome(el);
}

export function isOwnNode(n: Node): boolean {
  return n instanceof Element && (n.id === HOST_ID || OWN_CLASSES.some((c) => n.classList.contains(c)));
}

export function shouldSkip(el: Element): boolean {
  if (SKIP_TAGS.has(tagOf(el)) || isOwnNode(el)) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  if (el.classList.contains('notranslate') || el.getAttribute('translate') === 'no') return true;
  return el.getAttribute('aria-hidden') === 'true';
}

export function isBlockLike(el: Element): boolean {
  const tag = tagOf(el);
  if (BLOCK_TAGS.has(tag)) return true;
  if (INLINE_TAGS.has(tag)) return !!el.querySelector(BLOCK_SELECTOR);
  if (SKIP_TAGS.has(tag)) return false;
  const d = getComputedStyle(el).display;
  return /^(block|flex|grid|list-item|table|flow-root)/.test(d) || !!el.querySelector(BLOCK_SELECTOR);
}

function isFlexOrGrid(el: Element): boolean {
  if (SKIP_TAGS.has(tagOf(el))) return false;
  return /^(inline-)?(flex|grid)$/.test(getComputedStyle(el).display);
}

/**
 * 视觉上隐藏、只给读屏软件用的元素（sr-only、visually-hidden、隐藏的 tooltip 等）。
 * 它们在页面上只占 1px，但 innerText 仍会包含其文字。
 */
export function isVisuallyHidden(el: Element): boolean {
  const st = getComputedStyle(el);
  if (st.visibility === 'hidden' || st.visibility === 'collapse' || st.opacity === '0') return true;
  if (st.position !== 'absolute' && st.position !== 'fixed') return false;
  const h = el as HTMLElement;
  if (h.offsetWidth <= 2 || h.offsetHeight <= 2) return true;
  return /^rect\(0/.test(st.clip) || /inset\(\s*50%/.test(st.clipPath);
}

/** 元素的可见文字：去掉视觉隐藏的子元素里的文字 */
export function getText(el: Element): string {
  let text = (el as HTMLElement).innerText ?? el.textContent ?? '';
  if (el.childElementCount) {
    for (const d of el.querySelectorAll('*')) {
      if (isOwnNode(d) || !isVisuallyHidden(d)) continue;
      const hidden = ((d as HTMLElement).innerText ?? '').trim();
      if (hidden) text = text.replace(hidden, '');
    }
  }
  return text.replace(/[ \t]+\n/g, '\n').trim();
}

const CJK = /[぀-ヿ一-鿿가-힯]/;

function ratio(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length / text.length;
}

/** 正则粗判文本是否已是目标语言（内置语言检测不可用时的兜底） */
export function looksLikeTarget(text: string, target: string): boolean {
  const t = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (!t) return true;
  if (target.startsWith('zh')) return ratio(t, /[一-鿿]/g) > 0.5 && ratio(t, /[぀-ヿ]/g) < 0.05;
  if (target === 'ja') return ratio(t, /[぀-ヿ]/g) > 0.1;
  if (target === 'ko') return ratio(t, /[가-힯]/g) > 0.5;
  if (target === 'en') {
    return ratio(t, /[a-z]/gi) > 0.95 && /\b(the|and|is|are|of|to|in|for|with|this|that)\b/i.test(text);
  }
  return false;
}

/**
 * 判断文本是不是"需要翻译的自然语言"，排除：
 * 网址、邮箱、代码标识符、文件路径、版本号、日期时间、数字计量、@用户名、#话题、快捷键等
 */
export function isNaturalText(text: string): boolean {
  const t = text.trim();
  if (!t || !/\p{L}/u.test(t)) return false;
  if (t.length < 2 && !CJK.test(t)) return false;
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  // 字母占比太低：多为数字、价格、日期、统计数据（如 "12 points · 3 hours ago" 仍保留）
  if (letters / t.replace(/\s/g, '').length < 0.4) return false;
  if (/\s/.test(t) || CJK.test(t)) {
    // 多个词：只排除整段都是网址 / 邮箱 / 标签的情况
    return !t.split(/\s+/).every((w) => /^(https?:\/\/|www\.|[@#])\S+$|^\S+@\S+\.\S+$|^[·•|/\-–—]+$/i.test(w));
  }
  // 单个词（无空格）
  if (/^(https?:\/\/|www\.)/i.test(t) || /^\S+@\S+\.\S+$/.test(t)) return false;
  if (/^[@#$]/.test(t)) return false; // @用户名、#话题、$变量
  if (/[_/\\]|::|->|=>|\(\)|\.\w/.test(t)) return false; // snake_case、路径、a.b、foo()
  if (/^[a-z]+[A-Z]\w*$/.test(t) || /^[A-Z][a-z]+[A-Z]\w*$/.test(t)) return false; // camelCase、PascalCase
  if (/^v?\d+(\.\d+)+/i.test(t)) return false; // 版本号
  if (/^\d+\p{L}{1,3}$/u.test(t)) return false; // 带单位的数字：3h、5min、10km
  if (/^(Ctrl|Cmd|Alt|Shift|Meta|Option)\+/i.test(t)) return false; // 快捷键
  if (/^[A-Z0-9]{2,}$/.test(t)) return false; // 缩写：API、HTML、CEO
  return true;
}

export function isMeaningful(text: string, target: string): boolean {
  return isNaturalText(text) && !looksLikeTarget(text, target);
}

/**
 * 从 root 开始收集翻译单元。
 * - 没有块级子元素的元素 → 一个单元
 * - 块级元素之间夹着的裸文字（如 HN 评论第一段）→ 用 <font class="bilingo-wrap"> 包起来作为单元
 */
export interface CollectOptions {
  target: string;
  /** 智能模式：跳过网页界面元素 */
  smart: boolean;
}

export function collectSegments(root: Element, opts: CollectOptions, out: Element[] = []): Element[] {
  if (shouldSkip(root) || root.hasAttribute(STATE_ATTR)) return out;
  if (opts.smart && isUiChrome(root)) return out;
  const target = opts.target;

  // flex / grid 容器的子元素会被 CSS "块级化"，各自是独立的项目（如一排标签、按钮、卡片），不能合并成一句
  const itemsAreBlocks = isFlexOrGrid(root) && root.children.length > 1;
  const isBlockChild = (n: Element) => itemsAreBlocks || isBlockLike(n);
  const hasBlockChild = [...root.children].some(isBlockChild);
  if (!hasBlockChild) {
    const text = getText(root);
    if (isMeaningful(text, target) && !(opts.smart && isUiText(root, text))) out.push(root);
    return out;
  }

  let run: ChildNode[] = [];
  const flushRun = () => {
    // 判断是否有意义时不计入表单控件、代码等被跳过元素里的文字
    const text = run
      .map((n) => (n instanceof Element && shouldSkip(n) ? '' : (n.textContent ?? '')))
      .join('')
      .trim();
    if (run.length && isMeaningful(text, target)) {
      const wrap = root.ownerDocument.createElement('font');
      wrap.className = 'bilingo-wrap';
      run[0]!.before(wrap);
      wrap.append(...run);
      out.push(wrap);
    }
    run = [];
  };

  for (const n of [...root.childNodes]) {
    if (opts.smart && n instanceof Element && isUiChrome(n)) {
      // 夹在文字中间的按钮等界面元素：结束当前文字段，自身不翻译
      flushRun();
    } else if (n.nodeType === Node.TEXT_NODE || (n instanceof Element && !isBlockChild(n))) {
      run.push(n);
    } else if (n instanceof Element) {
      flushRun();
      collectSegments(n, opts, out);
    }
  }
  flushRun();
  return out;
}

const SHORT_INLINE_TAGS = new Set(['A', 'LI', 'TD', 'TH', 'DT', 'SPAN', 'LABEL', 'SUMMARY', 'BUTTON']);

/** 短小的导航项、按钮、表格单元格：译文跟在原文后面同一行，避免撑乱布局 */
export function preferInline(el: Element, src: string): boolean {
  if (src.length > 40 || src.includes('\n') || /^H[1-6]$/.test(tagOf(el))) return false;
  return SHORT_INLINE_TAGS.has(tagOf(el)) || !!el.closest('nav, button, [role="button"], [role="menu"], [role="tab"]');
}

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

export function getText(el: Element): string {
  return ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();
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

export function isMeaningful(text: string, target: string): boolean {
  if (!text || !/\p{L}/u.test(text)) return false;
  if (text.length < 2 && !CJK.test(text)) return false;
  if (/^(https?:\/\/|www\.)\S+$/i.test(text) || /^\S+@\S+\.\S+$/.test(text)) return false;
  return !looksLikeTarget(text, target);
}

/**
 * 从 root 开始收集翻译单元。
 * - 没有块级子元素的元素 → 一个单元
 * - 块级元素之间夹着的裸文字（如 HN 评论第一段）→ 用 <font class="bilingo-wrap"> 包起来作为单元
 */
export function collectSegments(root: Element, target: string, out: Element[] = []): Element[] {
  if (shouldSkip(root) || root.hasAttribute(STATE_ATTR)) return out;

  const hasBlockChild = [...root.children].some(isBlockLike);
  if (!hasBlockChild) {
    if (isMeaningful(getText(root), target)) out.push(root);
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
    if (n.nodeType === Node.TEXT_NODE || (n instanceof Element && !isBlockLike(n))) {
      run.push(n);
    } else if (n instanceof Element) {
      flushRun();
      collectSegments(n, target, out);
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

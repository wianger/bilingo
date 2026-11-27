// 正文区域识别：文章类网页（新闻、博客、文档）用 Mozilla Readability（Firefox 阅读模式的算法）找出正文所在区域。
// Readability 会修改它处理的 DOM，所以在网页副本上运行，再把选中的元素对应回真实网页。
// 真实网页只用来"圈定范围"，范围内仍按 segmenter 的规则逐段判断；非文章类网页（列表、论坛、GitHub 等）返回 null，退回全页规则。
import { isProbablyReaderable, Readability } from '@mozilla/readability';

/** 元素太多的超大页面不做识别（复制整页的开销太大） */
const MAX_ELEMENTS = 30_000;
const INDEX_ATTR = 'data-bilingo-i';
/** 识别出的正文至少要有这么多字，否则认为识别失败 */
const MIN_TEXT = 500;

export interface MainContent {
  /** 正文区域的根元素（真实网页中的元素） */
  roots: Element[];
  /** 正文区域外、但属于文章标题的元素（Readability 会把标题单独提取，不放在正文里） */
  headings: Element[];
}

export function detectMainContent(doc: Document = document): MainContent | null {
  if (!doc.body || doc.getElementsByTagName('*').length > MAX_ELEMENTS) return null;
  if (!isProbablyReaderable(doc)) return null;

  // 悬浮按钮挂在 <html> 下、<body> 之外，Readability 只看 <body>，所以不必从副本中删除
  const clone = doc.cloneNode(true) as Document;

  // 两棵树结构相同，按文档顺序一一对应：给副本里的每个元素标上序号。
  // 用属性而不是对象引用，是因为 Readability 正文太短时会用 innerHTML 重置页面再试，节点对象会全部换新，属性则会保留
  const liveEls: Element[] = [];
  const live = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
  const copy = clone.createTreeWalker(clone.documentElement, NodeFilter.SHOW_ELEMENT);
  for (let a: Node | null = live.currentNode, b: Node | null = copy.currentNode; a && b;) {
    (b as Element).setAttribute(INDEX_ATTR, String(liveEls.length));
    liveEls.push(a as Element);
    a = live.nextNode();
    b = copy.nextNode();
  }

  let article: { content: Element; textContent: string } | null;
  try {
    article = new Readability<Element>(clone, { serializer: (n) => n as Element }).parse() as typeof article;
  } catch {
    return null;
  }
  if (!article || article.textContent.trim().length < MIN_TEXT) return null;

  // 正文里能对应回真实网页的元素中，取最外层的作为根
  const mapped = new Set<Element>();
  for (const el of article.content.querySelectorAll(`[${INDEX_ATTR}]`)) {
    const l = liveEls[Number(el.getAttribute(INDEX_ATTR))];
    if (l && l !== doc.body && l !== doc.documentElement) mapped.add(l);
  }
  const roots = [...mapped].filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (mapped.has(p)) return false;
    return true;
  });
  if (!roots.length) return null;

  // 文章标题：正文区域外的 h1（Readability 会把标题单独提取，不放在正文里）
  let headings = [...doc.querySelectorAll('h1')].filter((h) => !roots.some((r) => r.contains(h)));

  // Readability 会丢掉正文里得分低的部分（小标题、图片说明、标题下的导语等），根元素可能零散或偏小。
  // 文章通常从标题开始到正文结束：取"标题 + 根元素"的公共祖先，只要它没有多出太多文字（不会把侧边栏圈进来）就用它
  const textLen = (el: Element) => ((el as HTMLElement).innerText ?? '').length;
  const parts = [...roots, ...headings];
  if (parts.length > 1) {
    const lca = commonAncestor(parts);
    const own = parts.reduce((n, r) => n + textLen(r), 0);
    if (lca && lca !== doc.body && lca !== doc.documentElement && textLen(lca) <= own * 1.6) {
      roots.splice(0, roots.length, lca);
      headings = headings.filter((h) => !lca.contains(h));
    }
  }
  return { roots, headings };
}

function commonAncestor(els: Element[]): Element | null {
  let a: Element | null = els[0]!;
  while (a && !els.every((e) => a!.contains(e))) a = a.parentElement;
  return a;
}

// 从 pdf.js 的文字条目（getTextContent().items）还原段落。
// PDF 里没有"段落"，只有一个个带坐标的文字片段；这里按几何关系把片段拼成行，再把行拼成段落：
// - 行：基线接近、水平方向首尾相接（上下标的基线偏移在容差内）
// - 段落：字号相近、行距稳定、水平范围重叠；首行缩进、上一行明显没写满、列表符号都表示新段落
// 内容流的顺序通常就是阅读顺序（双栏论文先左栏后右栏），这里沿用它，只在几何上不连续时断开。
// 公式、图中的小字、页码等不翻译。

/** pdf.js TextItem 中用到的字段 */
export interface TextItemLike {
  str: string;
  /** [a, b, c, d, e, f]，PDF 坐标系 */
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL?: boolean;
}

/** 一个可翻译的段落；坐标是缩放为 1 时视口上的 CSS 单位（左上角为原点） */
export interface Block {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 字号 */
  size: number;
  text: string;
  lines: number;
}

type Matrix = number[];

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0]! * m2[0]! + m1[2]! * m2[1]!,
    m1[1]! * m2[0]! + m1[3]! * m2[1]!,
    m1[0]! * m2[2]! + m1[2]! * m2[3]!,
    m1[1]! * m2[2]! + m1[3]! * m2[3]!,
    m1[0]! * m2[4]! + m1[2]! * m2[5]! + m1[4]!,
    m1[1]! * m2[4]! + m1[3]! * m2[5]! + m1[5]!,
  ];
}

interface Glyphs {
  x0: number;
  x1: number;
  /** 基线（视口坐标，向下为正） */
  base: number;
  size: number;
  text: string;
}

interface Line {
  x0: number;
  x1: number;
  base: number;
  /** 主体文字的字号（字符最多的片段） */
  size: number;
  text: string;
  main: number;
}

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/;
const EMAIL = /\S+@\S+\.\w+/;
const LIST_MARK = /^\s*(?:[•●○◦▪■□–—*·-]|\(?\d{1,2}[.)]|\(?[a-z][.)]|[ivx]{1,4}[.)])\s/i;

/** 把文字条目转成视口坐标；旋转、竖排的文字不处理 */
function toGlyphs(items: TextItemLike[], viewport: Matrix): Glyphs[] {
  const out: Glyphs[] = [];
  for (const it of items) {
    if (!it.str) continue;
    const [a, b, c, d, e, f] = multiply(viewport, it.transform);
    const size = Math.hypot(c!, d!);
    const scaleX = Math.hypot(a!, b!);
    if (!size || Math.abs(b!) > 0.05 * scaleX || a! <= 0) continue;
    // item.width 是页面坐标系里的宽度，乘以视口的缩放
    const w = it.width * Math.hypot(viewport[0]!, viewport[1]!);
    out.push({ x0: e!, x1: e! + w, base: f!, size, text: it.str });
  }
  return out;
}

function needsSpace(left: string, right: string): boolean {
  if (!left || !right || /\s$/.test(left) || /^\s/.test(right)) return false;
  return !(CJK.test(left.slice(-1)) && CJK.test(right[0]!));
}

/** 片段 → 行 */
export function toLines(glyphs: Glyphs[]): Line[] {
  const lines: Line[] = [];
  let cur: (Line & { mainLen: number }) | null = null;
  for (const g of glyphs) {
    if (cur) {
      const ref = Math.max(cur.size, g.size);
      const sameBase = Math.abs(g.base - cur.base) < 0.55 * ref;
      const gap = g.x0 - cur.x1;
      if (sameBase && gap > -1.2 * ref && gap < 1.5 * ref) {
        const blank = !g.text.trim();
        if (blank) {
          if (!/\s$/.test(cur.text)) cur.text += ' ';
        } else {
          if (gap > 0.15 * ref && needsSpace(cur.text, g.text)) cur.text += ' ';
          cur.text += g.text;
          const len = g.text.trim().length;
          if (len > cur.mainLen) {
            cur.mainLen = len;
            cur.size = g.size;
            cur.base = g.base;
          }
        }
        cur.x1 = Math.max(cur.x1, g.x1);
        continue;
      }
      lines.push(cur);
      cur = null;
    }
    if (!g.text.trim()) continue;
    cur = { ...g, main: 0, mainLen: g.text.trim().length };
  }
  if (cur) lines.push(cur);
  return lines
    .map((l) => ({ x0: l.x0, x1: l.x1, base: l.base, size: l.size, text: l.text.trim(), main: 0 }))
    .filter((l) => l.text);
}

interface RawBlock {
  lines: Line[];
  x0: number;
  x1: number;
  size: number;
  /** 行距（第二行出现后确定） */
  gap: number;
  /** 悬挂缩进的位置 */
  hang?: number;
}

/** 两行文字拼接：英文行末的连字符断词要接回去 */
function joinLines(lines: Line[]): string {
  let text = '';
  for (const l of lines) {
    if (!text) {
      text = l.text;
    } else if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(l.text)) {
      text = text.slice(0, -1) + l.text;
    } else {
      text += (needsSpace(text, l.text) ? ' ' : '') + l.text;
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 行内公式（根号、分式、求和号）的字形会打断内容流，同一行后半段被拆成单独的一行：
 * 和目标段落最后一行基线相同、位于其右侧，就接回那一行
 */
function continueLine(l: Line, b: RawBlock | null | undefined, fragment = ''): boolean {
  const last = b?.lines.at(-1);
  if (!b || !last) return false;
  const ref = Math.max(l.size, last.size);
  if (Math.abs(l.base - last.base) > 0.5 * ref || l.x0 < last.x1 - 0.5 * ref || l.x0 - last.x1 > 4 * ref) return false;
  for (const t of [fragment, l.text]) if (t) last.text += (needsSpace(last.text, t) ? ' ' : '') + t;
  last.x1 = Math.max(last.x1, l.x1);
  b.x1 = Math.max(b.x1, l.x1);
  return true;
}

/** 行 → 段落 */
function toRawBlocks(lines: Line[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  let cur: RawBlock | null = null;
  for (const l of lines) {
    if (continueLine(l, cur)) continue;
    // 中间夹着一小段公式碎片（单独成段）时，接回再前一段
    if (cur && cur.lines.length === 1 && cur.lines[0]!.text.length <= 6) {
      const prev = blocks.at(-1);
      if (continueLine(l, prev, cur.lines[0]!.text)) {
        blocks.pop();
        cur = prev!;
        continue;
      }
    }
    if (cur) {
      const last = cur.lines.at(-1)!;
      const dy = l.base - last.base;
      const sameSize = Math.abs(l.size - cur.size) <= 0.15 * cur.size;
      const lineGapOk = cur.gap ? Math.abs(dy - cur.gap) <= 0.3 * cur.gap : dy > 0.6 * cur.size && dy < 1.5 * cur.size;
      const overlap = Math.min(l.x1, cur.x1) - Math.max(l.x0, cur.x0);
      // 首行缩进的段落：第二行比第一行靠左
      const aligned = overlap > 0 && l.x0 >= cur.x0 - cur.size * (cur.lines.length === 1 ? 3 : 1.2);
      const width = cur.x1 - cur.x0;
      // 缩进：第二行相对第一行缩进，而第一行写满了 → 悬挂缩进（参考文献、多行标题），属于同一段；
      // 否则是新段落的首行缩进。之后的行以第二行（或悬挂缩进）的位置为准
      let indented = false;
      if (cur.lines.length === 1) {
        if (l.x0 > last.x0 + 0.8 * cur.size) {
          if (last.x1 >= l.x1 - 1.5 * cur.size) cur.hang = l.x0;
          else indented = true;
        }
      } else {
        const bodyX = cur.hang ?? cur.lines[1]!.x0;
        indented = l.x0 > bodyX + 0.8 * cur.size || (cur.hang !== undefined && l.x0 < cur.hang - 0.5 * cur.size);
      }
      // 上一行没写满、列表项：新段落
      const lastShort = cur.lines.length > 1 && last.x1 < cur.x1 - Math.max(2 * cur.size, 0.12 * width);
      const listItem = LIST_MARK.test(l.text);
      if (sameSize && lineGapOk && aligned && !indented && !lastShort && !listItem) {
        if (!cur.gap) cur.gap = dy;
        cur.lines.push(l);
        cur.x0 = Math.min(cur.x0, l.x0);
        cur.x1 = Math.max(cur.x1, l.x1);
        continue;
      }
      blocks.push(cur);
    }
    cur = { lines: [l], x0: l.x0, x1: l.x1, size: l.size, gap: 0 };
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/** 正文字号：按字符数加权的众数 */
function bodySize(lines: Line[]): number {
  const count = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.size * 2) / 2;
    count.set(k, (count.get(k) ?? 0) + l.text.length);
  }
  let best = 0;
  let max = -1;
  for (const [k, n] of count) {
    if (n > max) {
      max = n;
      best = k;
    }
  }
  return best;
}

/** 是否值得翻译：排除页码、公式、代码符号、图中的小字标注 */
export function isTranslatable(text: string, size: number, width: number, body: number, bodyWidth: number): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 2) return false;
  const compact = text.replace(/\s/g, '');
  // 字母占比太低：公式、数据、代码
  if (letters / compact.length < 0.55) return false;
  // 英文类文字至少要有一个像样的词（三个字母以上、含小写），排除变量名、缩写
  if (!CJK.test(text) && !/\p{L}\p{Ll}{2,}/u.test(text)) return false;
  const words = text.match(/\p{L}\p{Ll}{2,}/gu)?.length ?? 0;
  // 作者信息里的邮箱、网址行：人名、机构名机器翻译效果差，保留原文
  if ((EMAIL.test(text) || /https?:\/\//.test(text)) && words < 8) return false;
  // 行间公式：带数学符号、几乎没有普通单词
  if (/[=≤≥≈∑∏∫√∈→±×]/.test(text) && words < 3) return false;
  // 字号明显小于正文、宽度也窄：图表里的标注
  if (body && size < 0.85 * body && width < 0.5 * bodyWidth) return false;
  return true;
}

export function extractBlocks(items: TextItemLike[], viewportTransform: Matrix): Block[] {
  const lines = toLines(toGlyphs(items, viewportTransform));
  const raw = toRawBlocks(lines);
  const body = bodySize(lines);
  // 正文行宽：正文字号的段落里最宽的行（双栏时为栏宽）
  const bodyWidth = Math.max(1, ...raw.filter((b) => Math.abs(b.size - body) <= 0.15 * body).map((b) => b.x1 - b.x0));
  // 作者信息：邮箱行正上方紧挨着的短段落（姓名、机构）也保留原文
  const emails = raw.filter((b) => EMAIL.test(b.lines[0]!.text) && b.lines[0]!.text.split(/\s+/).length <= 3);
  const isAuthor = (b: RawBlock) =>
    joinLines(b.lines).split(/\s+/).length <= 8 &&
    emails.some((e) => {
      const below = e.lines[0]!.base - b.lines.at(-1)!.base;
      return below > 0 && below < 2 * b.size && Math.min(e.x1, b.x1) - Math.max(e.x0, b.x0) > 0;
    });
  const out: Block[] = [];
  for (const b of raw) {
    const text = joinLines(b.lines);
    const w = b.x1 - b.x0;
    if (!isTranslatable(text, b.size, w, body, bodyWidth) || isAuthor(b)) continue;
    const first = b.lines[0]!;
    const last = b.lines.at(-1)!;
    const top = first.base - 0.85 * b.size;
    const bottom = last.base + 0.25 * b.size;
    out.push({ x: b.x0, y: top, w, h: bottom - top, size: b.size, text, lines: b.lines.length });
  }
  return out;
}

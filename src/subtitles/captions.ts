// YouTube 字幕（json3 格式）解析与断句。
// json3：{ events: [{ tStartMs, dDurationMs, segs: [{ utf8, tOffsetMs }], aAppend? }] }
// - 人工字幕：每个 event 是一行字幕
// - 自动字幕（ASR）：每个 seg 是一个词，带相对时间 tOffsetMs，aAppend 的 event 只是换行
// 机器翻译需要完整的句子，所以把零散的行 / 词拼成句子，同时限制每句的长度和时长，保证显示节奏。

export interface Cue {
  /** 毫秒 */
  start: number;
  end: number;
  text: string;
}

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: Json3Seg[];
}
export interface Json3 {
  events?: Json3Event[];
}

/** 句末标点（中英日韩阿等常见语言） */
const SENTENCE_END = /[.?!。？！…؟।]["'”’)\]]*$/;
/** 一句最长字符数（中日韩按字计，较短） */
const MAX_CHARS = 110;
const MAX_CHARS_CJK = 40;
/** 一句最长显示时长 */
const MAX_DURATION = 7000;
/** 两个词之间停顿超过这个时长就断句 */
const PAUSE = 1200;

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

interface Piece {
  time: number;
  end: number;
  text: string;
}

/** 把 json3 拆成按时间排列的片段：逐词时间轴的自动字幕一个词一个片段；按行给出的字幕按句末标点切开 */
export function toPieces(data: Json3): Piece[] {
  const out: Piece[] = [];
  const lines: Piece[] = [];
  for (const ev of data.events ?? []) {
    if (!ev.segs || ev.aAppend) continue;
    const start = ev.tStartMs ?? 0;
    const end = start + (ev.dDurationMs ?? 0);
    const segs = ev.segs.filter((s) => s.utf8 && s.utf8 !== '\n');
    const wordLevel = segs.some((s) => s.tOffsetMs !== undefined);
    if (wordLevel) {
      segs.forEach((s, i) => {
        const t = start + (s.tOffsetMs ?? 0);
        const next = segs[i + 1];
        let text = s.utf8!;
        // 自动字幕的换行由单独的换行事件表示，新一行的第一个词前面没有空格：补上（中日韩文字之间不加）
        const prev = out.at(-1)?.text ?? '';
        if (
          i === 0 &&
          prev &&
          !/\s$/.test(prev) &&
          !/^\s/.test(text) &&
          !CJK.test(prev.slice(-1)) &&
          !CJK.test(text[0]!)
        ) {
          text = ` ${text}`;
        }
        out.push({ time: t, end: next ? start + (next.tOffsetMs ?? 0) : end, text });
      });
    } else {
      const text = segs
        .map((s) => s.utf8)
        .join('')
        .replace(/\s*\n\s*/g, CJK.test(segs.map((s) => s.utf8).join('')) ? '' : ' ')
        .trim();
      if (text) lines.push({ time: start, end, text });
    }
  }
  // 按行给出的字幕：相邻两行常常时间重叠（滚动显示），每行只算到下一行开始；
  // 一行里可能有句子结束，按句末标点切开，时间按字数比例分配
  lines.sort((a, b) => a.time - b.time);
  lines.forEach((l, i) => {
    const next = lines[i + 1];
    const end = next && next.time > l.time ? Math.min(l.end, next.time) : l.end;
    const parts = l.text.split(/(?<=[.?!。？！…؟।]["'”’)\]]*)\s+/).filter(Boolean);
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let t = l.time;
    for (const part of parts) {
      const dur = ((end - l.time) * part.length) / total;
      out.push({ time: Math.round(t), end: Math.round(t + dur), text: ` ${part}` });
      t += dur;
    }
  });
  return out.sort((a, b) => a.time - b.time);
}

/** 把片段拼成句子 */
export function toSentences(pieces: Piece[]): Cue[] {
  const cues: Cue[] = [];
  let cur: Piece[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur
      .map((p) => p.text)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (text && !/^\[[^\]]*\]$/.test(text)) {
      cues.push({ start: cur[0]!.time, end: cur.at(-1)!.end, text });
    }
    cur = [];
  };
  for (const p of pieces) {
    if (cur.length) {
      const first = cur[0]!;
      const last = cur.at(-1)!;
      const text = cur.map((x) => x.text).join('');
      const max = CJK.test(text) ? MAX_CHARS_CJK : MAX_CHARS;
      const ended = SENTENCE_END.test(last.text.trim());
      if (
        ended ||
        p.time - last.end > PAUSE ||
        p.time - first.time > MAX_DURATION ||
        text.length + p.text.length > max
      ) {
        flush();
      }
    }
    cur.push(p);
  }
  flush();
  // 每句一直显示到下一句开始（不超过 2 秒的空档），避免字幕闪烁
  for (let i = 0; i < cues.length - 1; i++) {
    const next = cues[i + 1]!.start;
    if (next - cues[i]!.end < 2000) cues[i]!.end = next;
  }
  return cues;
}

export function parseJson3(data: Json3): Cue[] {
  return toSentences(toPieces(data));
}

/** 二分查找当前时间所在的字幕 */
export function cueAt(cues: Cue[], ms: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid]!;
    if (ms < c.start) hi = mid - 1;
    else if (ms >= c.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** WebVTT 字幕条目（来自 HTML5 视频的 TextTrack） */
export interface VttCueLike {
  /** 秒 */
  startTime: number;
  endTime: number;
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  nbsp: ' ',
  quot: '"',
  apos: "'",
  lrm: '',
  rlm: '',
};

/** 去掉 WebVTT 的标签（<v 说话人>、<c.颜色>、<i>、<00:00:01.000> 时间戳）并还原实体 */
export function cleanVttText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (all, e: string) =>
      e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? all),
    )
    .trim();
}

/**
 * HTML5 视频的字幕条目 → 句子。
 * 滚动式字幕（自动字幕常见）每条会重复上一条的最后一行，去掉重复的行后再按句子合并。
 */
export function fromVttCues(cues: VttCueLike[]): Cue[] {
  const events: Json3Event[] = [];
  let lastLine = '';
  for (const c of [...cues].sort((a, b) => a.startTime - b.startTime)) {
    const lines = cleanVttText(c.text)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const fresh = lines.filter((l, i) => !(i === 0 && l === lastLine));
    if (lines.length) lastLine = lines.at(-1)!;
    if (!fresh.length) continue;
    const start = Math.round(c.startTime * 1000);
    events.push({
      tStartMs: start,
      dDurationMs: Math.round(c.endTime * 1000) - start,
      segs: [{ utf8: fresh.join('\n') }],
    });
  }
  return parseJson3({ events });
}

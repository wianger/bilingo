import { describe, expect, it } from 'vitest';
import { extractBlocks, type TextItemLike } from '@/pdf/layout';
import { decodeRegions, type Region } from '@/pdf/layout-model';

/** 缩放为 1 的视口：PDF 坐标（原点在左下）→ 页面坐标（原点在左上），页面高 800 */
const VIEWPORT = [1, 0, 0, -1, 0, 800];
/** 每个字符按 0.5 个字号宽估算 */
const item = (str: string, x: number, baseline: number, size = 10): TextItemLike => ({
  str,
  transform: [size, 0, 0, size, x, 800 - baseline],
  width: str.length * size * 0.5,
  height: size,
  fontName: 'f1',
});
const texts = (items: TextItemLike[]) => extractBlocks(items, VIEWPORT).map((b) => b.text);

describe('PDF paragraph detection', () => {
  it('joins lines into paragraphs, splits at first-line indents and rejoins hyphenated words', () => {
    const items = [
      item('Language barriers in scientific documents hinder the diffu-', 70, 100),
      item('sion of science. Prior efforts overlooked the layout of', 70, 112),
      item('documents entirely.', 70, 124),
      item('To fill the gap, we introduce a tool that translates whole', 80, 136),
      item('documents while keeping their original layouts intact.', 70, 148),
    ];
    expect(texts(items)).toEqual([
      'Language barriers in scientific documents hinder the diffusion of science. Prior efforts overlooked the layout of documents entirely.',
      'To fill the gap, we introduce a tool that translates whole documents while keeping their original layouts intact.',
    ]);
  });

  it('keeps superscripts and inline pieces on the same line', () => {
    const items = [
      item('The model uses ONNX', 70, 100),
      item('2', 170, 96, 7),
      item(' ', 173, 100),
      item('as the default format for diverse hardware.', 176, 100),
    ];
    expect(texts(items)).toEqual(['The model uses ONNX 2 as the default format for diverse hardware.']);
  });

  it('reattaches the rest of a line broken by an inline formula', () => {
    // "√" 的基线偏低、下标更小，内容流在这里断开；后半行应接回原段落
    const items = [
      item('We compute the dot products of the query with all keys and divide each by', 70, 100),
      item('√', 445, 106),
      item('dk, and apply a softmax function to obtain the weights on the values of', 460, 100),
      item('the keys, which gives the attention output for every query in the batch.', 70, 112),
    ];
    const [text] = texts(items);
    expect(text).toContain('divide each by √ dk, and apply a softmax');
    expect(texts(items)).toHaveLength(1);
  });

  it('treats hanging indents (references) as one paragraph each', () => {
    const items = [
      item('Zhiyuan Zhao, Hengrui Kang, Bin Wang, Jun Li, and Conghui', 70, 100),
      item('He. 2024. DocLayout-YOLO: Enhancing document layout', 80, 112),
      item('analysis through diverse synthetic data.', 80, 124),
      item('Jinhua Zhu, Yingce Xia, Lijun Wu, Di He, Tao Qin and', 70, 136),
      item('Wengang Zhou. 2020. Incorporating BERT into neural', 80, 148),
    ];
    expect(texts(items)).toEqual([
      'Zhiyuan Zhao, Hengrui Kang, Bin Wang, Jun Li, and Conghui He. 2024. DocLayout-YOLO: Enhancing document layout analysis through diverse synthetic data.',
      'Jinhua Zhu, Yingce Xia, Lijun Wu, Di He, Tao Qin and Wengang Zhou. 2020. Incorporating BERT into neural',
    ]);
  });

  it('separates headings and list items from body text', () => {
    const items = [
      item('2.1 Precise layout parser', 70, 100),
      item('Preserving layouts requires precise layout extraction from', 70, 120),
      item('the document before any translation can happen at all.', 70, 132),
      item('• first, the layout is detected', 70, 144),
      item('• then, the text is translated', 70, 156),
    ];
    expect(texts(items)).toEqual([
      '2.1 Precise layout parser',
      'Preserving layouts requires precise layout extraction from the document before any translation can happen at all.',
      '• first, the layout is detected',
      '• then, the text is translated',
    ]);
  });

  it('skips page numbers, display formulas, author lines and small figure labels', () => {
    const body = (y: number) => item('This is a normal line of body text that is long enough to set the width.', 70, y);
    const items = [
      body(100),
      body(112),
      item('Attention(Q, K, V) = softmax(QK)V', 200, 150),
      item('Ashish Vaswani Google Brain', 200, 168),
      item('avaswani@google.com', 200, 180),
      item('Censorship has', 300, 220, 7),
      item('12', 290, 780),
    ];
    const out = texts(items);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^This is a normal line/);
  });

  it('joins CJK lines without spaces', () => {
    const items = [
      item('语言障碍阻碍了科学技术的传播与发展，以往的工作', 70, 100),
      item('忽略了文档的排版。', 70, 112),
    ];
    expect(texts(items)).toEqual(['语言障碍阻碍了科学技术的传播与发展，以往的工作忽略了文档的排版。']);
  });

  it('reports block positions in page coordinates', () => {
    const [b] = extractBlocks([item('A single line of text for the position test.', 70, 100)], VIEWPORT);
    expect(b!.x).toBe(70);
    expect(b!.y).toBeCloseTo(100 - 8.5);
    expect(b!.size).toBe(10);
  });
});

describe('PDF paragraphs with AI layout regions', () => {
  const region = (label: Region['label'], x0: number, y0: number, x1: number, y1: number, order: number): Region => ({
    label,
    score: 0.9,
    x0,
    y0,
    x1,
    y1,
    order,
  });

  it('groups lines by region, skips formula regions and keeps uncovered lines', () => {
    const items = [
      item('A heading that the model detected', 70, 100),
      // 首行缩进在几何规则里会被拆开；模型说它们是同一段
      item('First line of a paragraph that the model', 80, 120),
      item('detected as one text region on the page.', 70, 132),
      item('Attention of the queries and the keys = softmax', 150, 160),
      item('A line that no region covers stays translatable.', 70, 200),
    ];
    const regions = [
      region('paragraph_title', 65, 88, 300, 104, 1),
      region('text', 65, 108, 320, 136, 2),
      region('display_formula', 140, 148, 420, 164, 3),
      region('inline_formula', 100, 108, 140, 124, 4),
    ];
    expect(extractBlocks(items, VIEWPORT, regions).map((b) => b.text)).toEqual([
      'A heading that the model detected',
      'First line of a paragraph that the model detected as one text region on the page.',
      'A line that no region covers stays translatable.',
    ]);
  });

  it('orders blocks by the model reading order and leaves tables and headers alone', () => {
    const items = [
      item('Right column paragraph text goes here.', 320, 100),
      item('Left column paragraph text goes here.', 70, 100),
      item('Model accuracy table header cell', 70, 300),
      item('Journal of Example Studies, Volume 1', 70, 40),
    ];
    const regions = [
      region('text', 315, 88, 560, 104, 2),
      region('text', 65, 88, 300, 104, 1),
      region('table', 60, 280, 560, 320, 3),
      region('header', 60, 30, 560, 44, 0),
    ];
    expect(
      extractBlocks(
        items,
        VIEWPORT,
        [...regions].sort((a, b) => a.order - b.order),
      ).map((b) => b.text),
    ).toEqual(['Left column paragraph text goes here.', 'Right column paragraph text goes here.']);
  });
});

describe('layout model output', () => {
  it('decodes rows into page regions sorted by reading order, dropping low scores', () => {
    // [类别, 置信度, x1, y1, x2, y2, 顺序]，800×800 坐标
    const rows = new Float32Array([22, 0.9, 400, 400, 800, 800, 5, 17, 0.8, 0, 0, 400, 80, 1, 5, 0.3, 0, 0, 10, 10, 0]);
    const regions = decodeRegions(rows, 3, 600, 800);
    expect(regions.map((r) => r.label)).toEqual(['paragraph_title', 'text']);
    expect(regions[1]).toMatchObject({ x0: 300, y0: 400, x1: 600, y1: 800 });
  });
});

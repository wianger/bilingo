// AI 版面分析（可选）：PP-DocLayoutV3（PaddleOCR 3.x，Apache-2.0），为 onnxruntime-web WebGPU 导出的 fp16 版本，约 66MB。
// 模型识别页面上的区域（正文、标题、图注、行间公式、表格、页眉页脚……）并给出阅读顺序；
// 文字仍取自 PDF 本身，模型只决定哪些行属于同一段、哪些区域不翻译。
// 来源：https://huggingface.co/traceray/nexus-layout（转换自 PaddlePaddle/PP-DocLayoutV3_onnx）

/** 固定到具体提交，并校验文件哈希 */
export const LAYOUT_MODEL = {
  repo: 'traceray/nexus-layout',
  revision: '83453d9b049e29681a43329376552cf53c61773b',
  file: 'pp-doclayoutv3-w16.onnx',
  sha256: 'a8d186a39f10f4bf46fc6856d1c74ba104c51371c0db0d274faaa5486c79c747',
  bytes: 65_751_638,
  /** 模型输入：页面拉伸到 800×800（不保持比例） */
  size: 800,
};

export const layoutModelUrl = (host: string) =>
  `${host.endsWith('/') ? host : `${host}/`}${LAYOUT_MODEL.repo}/resolve/${LAYOUT_MODEL.revision}/${LAYOUT_MODEL.file}`;

/** 类别（与官方 inference.yml 的 label_list 顺序一致） */
export const LAYOUT_LABELS = [
  'abstract',
  'algorithm',
  'aside_text',
  'chart',
  'content',
  'display_formula',
  'doc_title',
  'figure_title',
  'footer',
  'footer_image',
  'footnote',
  'formula_number',
  'header',
  'header_image',
  'image',
  'inline_formula',
  'number',
  'paragraph_title',
  'reference',
  'reference_content',
  'seal',
  'table',
  'text',
  'vertical_text',
  'vision_footnote',
] as const;

export type LayoutLabel = (typeof LAYOUT_LABELS)[number];

/** 需要翻译的区域；其余（公式、表格、图片、页眉页脚、页码、参考文献、算法、印章）保持原文 */
export const TRANSLATABLE: ReadonlySet<LayoutLabel> = new Set([
  'abstract',
  'aside_text',
  'content',
  'doc_title',
  'figure_title',
  'footnote',
  'paragraph_title',
  'text',
  'vision_footnote',
]);

/** 行内公式在正文区域里面，分配文字行时忽略它 */
export const IGNORED: ReadonlySet<LayoutLabel> = new Set(['inline_formula']);

/** 一个区域；坐标是缩放为 1 时的页面坐标（PDF 单位，左上角为原点） */
export interface Region {
  label: LayoutLabel;
  score: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 阅读顺序 */
  order: number;
}

/** 低于这个置信度的区域不采用 */
export const MIN_SCORE = 0.5;

/** 模型输出 [类别, 置信度, x1, y1, x2, y2, 顺序] × N（800×800 坐标）→ 页面坐标的区域，按阅读顺序排列 */
export function decodeRegions(rows: Float32Array, count: number, pageWidth: number, pageHeight: number): Region[] {
  const sx = pageWidth / LAYOUT_MODEL.size;
  const sy = pageHeight / LAYOUT_MODEL.size;
  const out: Region[] = [];
  for (let r = 0; r < count; r++) {
    const [cls, score, x1, y1, x2, y2, order] = rows.subarray(r * 7, r * 7 + 7);
    const label = LAYOUT_LABELS[Math.round(cls!)];
    if (!label || score! < MIN_SCORE) continue;
    out.push({ label, score: score!, x0: x1! * sx, y0: y1! * sy, x1: x2! * sx, y1: y2! * sy, order: order! });
  }
  return out.sort((a, b) => a.order - b.order);
}

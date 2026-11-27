// 可选的本地翻译模型（Transformers.js + WebGPU）
// 选择依据见 README「本地大模型」一节；新增模型前需确认：有 ONNX 版本、能被 Transformers.js 的 text-generation 加载。

/** 提示词格式：决定如何把待译文本交给模型 */
export type PromptFormat = 'hymt' | 'translategemma';

export interface LocalModelPreset {
  /** Hugging Face 仓库 id */
  repo: string;
  name: string;
  /** 约下载大小（MB） */
  sizeMB: number;
  license: string;
  desc: string;
  format: PromptFormat;
  /** 固定量化方式；不填则按显卡能力自动选 q4f16 / q4 */
  dtype?: 'q4' | 'q4f16';
  experimental?: boolean;
}

export const LOCAL_MODELS: LocalModelPreset[] = [
  {
    repo: 'drnfns/Hy-MT2-1.8B-ONNX',
    name: 'Hy-MT2 1.8B（推荐）',
    sizeMB: 1085,
    license: 'Apache-2.0',
    desc: '腾讯 2026 年 5 月发布的翻译专用模型，33 种语言，体积与质量最平衡（社区 ONNX 转换版）',
    format: 'hymt',
  },
  {
    repo: 'onnx-community/translategemma-text-4b-it-ONNX',
    name: 'TranslateGemma 4B',
    sizeMB: 3112,
    license: 'Gemma 使用条款',
    desc: 'Google 的翻译专用模型，55 种语言，质量更高但更慢、更占显存（建议 6GB 以上显存）',
    format: 'translategemma',
    // Gemma 系列在 WebGPU 上用 fp16 计算会输出乱码（onnxruntime#26732），官方演示同样使用 q4
    dtype: 'q4',
    experimental: true,
  },
];

export function findPreset(repo: string): LocalModelPreset | undefined {
  return LOCAL_MODELS.find((m) => m.repo === repo);
}

/** 自定义模型按 Hy-MT 的通用指令格式处理 */
export function formatOf(repo: string): PromptFormat {
  return findPreset(repo)?.format ?? 'hymt';
}

// TranslateGemma 聊天模板里的语言代码表（只列主语言部分），模板遇到未知代码会直接报错
const TG_BASES = new Set(
  'aa ab af ak am an ar as az ba be bg bm bn bo br bs ca ce co cs cv cy da de dv dz ee el en eo es et eu fa ff fi fo fr fy ga gd gl gn gu gv ha he hi hr ht hu hy ia id ie ig ii ik io is it iu ja jv ka ki kk kl km kn ko ks ku kw ky la lb lg ln lo lt lu lv mg mi mk ml mn mr ms mt my nb nd ne nl nn no nr nv ny oc om or os pa pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(
    ' ',
  ),
);

/** 转成 TranslateGemma 认识的语言代码；无法识别时返回 null */
export function toTranslateGemmaCode(code: string): string | null {
  const c = code.replace('_', '-');
  const lower = c.toLowerCase();
  if (lower === 'zh-tw' || lower === 'zh-hant' || lower === 'zh-hk') return 'zh-TW';
  const base = lower.split('-')[0]!;
  return TG_BASES.has(base) ? base : null;
}

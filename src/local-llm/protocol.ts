import type { PromptFormat } from './models';

export interface LocalModelConfig {
  /** Hugging Face 模型仓库 id */
  model: string;
  /** 模型下载源（Hugging Face 或镜像），以 / 结尾 */
  host: string;
  format: PromptFormat;
  /** 固定量化方式；不填则自动选择 */
  dtype?: 'q4' | 'q4f16';
}

export type LocalStatus =
  | { state: 'idle' }
  | {
      state: 'downloading';
      progress: number;
      loaded: number;
      total: number;
      /** 已开始请求但还没收到数据的文件数（正在连接下载服务器） */
      waiting: number;
    }
  | { state: 'loading' }
  | { state: 'ready'; dtype: string; adapter: string }
  | { state: 'error'; message: string };

/** 主线程 → Worker */
export type WorkerRequest =
  | { id: number; type: 'load'; config: LocalModelConfig }
  | {
      id: number;
      type: 'translate';
      config: LocalModelConfig;
      texts: string[];
      targetLang: string;
      /** 每段原文的语言（TranslateGemma 需要） */
      sourceLangs?: string[];
    };

/** Worker → 主线程 */
export type WorkerResponse =
  | { id: number; type: 'result'; result?: string[] }
  | { id: number; type: 'error'; message: string }
  | { type: 'status'; status: LocalStatus };

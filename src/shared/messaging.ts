import { defineExtensionMessaging } from '@webext-core/messaging';
import type { LocalModelConfig, LocalStatus } from '@/local-llm/protocol';
import type { SettingsPatch } from './settings';

interface ProtocolMap {
  // 内容脚本 / 设置页 → 后台
  translate(data: { texts: string[]; override?: SettingsPatch }): string[];
  listModels(data: { baseUrl: string; apiKey: string }): string[];
  clearCache(): void;
  /** 设置页：预先下载 / 加载本地模型 */
  localPrepare(): void;
  /** 设置页：卸载本地模型，释放显存 */
  localUnload(): void;

  // 后台 / 弹窗 → 内容脚本
  toggle(): { active: boolean };
  status(): { active: boolean };
  retranslate(): { active: boolean };
  translateSelection(): void;
  /** 在网页上点选区域，生成网站规则 */
  startPicker(): void;

  // 后台 → offscreen 文档（本地大模型）
  llmLoad(data: { config: LocalModelConfig }): void;
  llmTranslate(data: {
    config: LocalModelConfig;
    texts: string[];
    targetLang: string;
    sourceLangs?: string[];
  }): string[];
  // 任意扩展页面 → offscreen 文档
  llmStatus(): LocalStatus;
  // offscreen 文档 → 广播
  llmStatusChanged(data: LocalStatus): void;
  // offscreen 文档 → 后台：空闲超时，请求关闭自己以释放显存
  llmIdle(): void;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();

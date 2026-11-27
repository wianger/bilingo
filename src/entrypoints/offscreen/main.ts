// offscreen 文档：常驻托管本地翻译模型（service worker 空闲会被回收，不适合持有 1GB 模型）
import { LocalLlmHost } from '@/local-llm/host';
import { onMessage, sendMessage } from '@/shared/messaging';

const IDLE_MS = 10 * 60 * 1000;
const host = new LocalLlmHost();
let idleTimer = 0;

function touch() {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    // 下载 1GB 模型可能超过 10 分钟：忙碌时顺延，绝不能中途卸载（下载未完成的文件不会进缓存，会从头再来）
    if (host.busy) return touch();
    host.dispose();
    sendMessage('llmIdle', undefined).catch(() => {});
  }, IDLE_MS);
}

host.onStatus = (status) => {
  // 广播给打开着的设置页；没有接收方时忽略
  sendMessage('llmStatusChanged', status).catch(() => {});
};

onMessage('llmLoad', ({ data }) => {
  touch();
  void host.load(data.config).catch(() => {});
});

onMessage('llmTranslate', async ({ data }) => {
  touch();
  try {
    return await host.translate(data.config, data.texts, data.targetLang, data.sourceLangs);
  } finally {
    touch();
  }
});

onMessage('llmStatus', () => host.status);

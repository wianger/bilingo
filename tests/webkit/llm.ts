// 相当于扩展里的 offscreen.html（去掉扩展消息部分）：托管模型 Worker，暴露接口给父页面
import { exposeApi } from '@/local-llm/frame';
import { LocalLlmHost } from '@/local-llm/host';

const host = new LocalLlmHost();
exposeApi({
  load: (config) => host.load(config),
  translate: (config, texts, targetLang, sourceLangs) => host.translate(config, texts, targetLang, sourceLangs),
  status: () => host.status,
  dispose: () => host.dispose(),
});

// 没有 offscreen API 的浏览器（Safari）：后台本身是一个有 DOM 的页面，
// 把同一个 offscreen.html 作为隐藏 iframe 放进后台页面，直接调用它暴露的接口（同源，不经过消息传递）。
import type { LocalModelConfig, LocalStatus } from './protocol';

export interface FrameApi {
  load(config: LocalModelConfig): Promise<void>;
  translate(config: LocalModelConfig, texts: string[], targetLang: string, sourceLangs?: string[]): Promise<string[]>;
  status(): LocalStatus;
  dispose(): void;
}

declare global {
  interface Window {
    bilingoLlm?: FrameApi;
  }
}

const FRAME_ID = 'bilingo-llm-frame';
let ready: Promise<FrameApi> | null = null;

/** 当前环境能否用 iframe 托管模型（有 DOM，例如 Safari 的后台页面） */
export const canUseFrame = () => typeof document !== 'undefined' && typeof Worker !== 'undefined';

/** 在 offscreen 页面里调用：暴露接口给父页面 */
export function exposeApi(api: FrameApi) {
  window.bilingoLlm = api;
}

/** 获取（必要时创建）托管模型的 iframe 的接口 */
export function frameApi(url: string): Promise<FrameApi> {
  ready ??= new Promise<FrameApi>((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.src = url;
    frame.style.display = 'none';
    const timer = setTimeout(() => fail(new Error('Timed out loading the local model host')), 30_000);
    const fail = (e: Error) => {
      clearTimeout(timer);
      frame.remove();
      ready = null;
      reject(e);
    };
    frame.addEventListener('load', () => {
      // 模块脚本可能在 load 之后才执行完，稍等接口出现
      const check = (tries: number) => {
        const api = frame.contentWindow?.bilingoLlm;
        if (api) {
          clearTimeout(timer);
          resolve(api);
        } else if (tries > 0) setTimeout(() => check(tries - 1), 50);
        else fail(new Error('Local model host did not start'));
      };
      check(100);
    });
    (document.body ?? document.documentElement).append(frame);
  });
  return ready;
}

/** 移除 iframe，释放模型占用的显存 */
export function removeFrame() {
  const frame = document.getElementById(FRAME_ID) as HTMLIFrameElement | null;
  frame?.contentWindow?.bilingoLlm?.dispose();
  frame?.remove();
  ready = null;
}

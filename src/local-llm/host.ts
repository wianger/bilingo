// 管理运行模型的 Worker（运行在 offscreen 文档中）
import { m } from '@/shared/i18n';
import type { LocalModelConfig, LocalStatus, WorkerRequest, WorkerResponse } from './protocol';

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type Pending = { resolve: (v: string[] | undefined) => void; reject: (e: Error) => void };

export class LocalLlmHost {
  status: LocalStatus = { state: 'idle' };
  onStatus?: (s: LocalStatus) => void;

  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  /** 正在下载 / 加载模型或翻译中（此时不能因空闲而卸载） */
  get busy(): boolean {
    return this.pending.size > 0 || this.status.state === 'downloading' || this.status.state === 'loading';
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.addEventListener('message', (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === 'status') {
        this.status = msg.status;
        this.onStatus?.(msg.status);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === 'result') p.resolve(msg.result);
      else p.reject(new Error(msg.message));
    });
    w.addEventListener('error', (ev) => {
      const err = new Error(m.err_worker_crash({ msg: ev.message }));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
      this.status = { state: 'error', message: err.message };
      this.onStatus?.(this.status);
    });
    this.worker = w;
    return w;
  }

  private call(req: WithoutId<WorkerRequest>): Promise<string[] | undefined> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg: WorkerRequest = { ...req, id };
      this.ensureWorker().postMessage(msg);
    });
  }

  load(config: LocalModelConfig): Promise<void> {
    return this.call({ type: 'load', config }).then(() => undefined);
  }

  async translate(
    config: LocalModelConfig,
    texts: string[],
    targetLang: string,
    sourceLangs?: string[],
  ): Promise<string[]> {
    return (await this.call({ type: 'translate', config, texts, targetLang, sourceLangs })) ?? [];
  }

  /** 释放显存 */
  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error(m.err_model_unloaded()));
    this.pending.clear();
    this.status = { state: 'idle' };
    this.onStatus?.(this.status);
  }
}

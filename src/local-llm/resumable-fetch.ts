import { m } from '@/shared/i18n';

// 可断点续传的 fetch：给 Transformers.js 用（env.fetch）。
// Transformers.js 只有在整个文件下载完后才写入缓存，1GB 的模型文件一旦中断（关闭浏览器、网络波动、扩展重载）就要从头再来。
// 这里把大文件按 HTTP Range 分块下载，每块下载完立即存入 Cache Storage；重新开始时跳过已有分块，
// 再把所有分块拼成一个流式 Response 交回给 Transformers.js（进度条照常工作，已下载的部分会瞬间走完）。

export const PARTIAL_CACHE = 'bilingo-partial-downloads';

export interface ResumableOptions {
  fetch?: typeof fetch;
  /** 打开存放分块的缓存 */
  openCache?: () => Promise<Pick<Cache, 'match' | 'put' | 'delete' | 'keys'>>;
  /** 每块大小，默认 16MB */
  chunkSize?: number;
  /** 只有匹配的 URL 才分块下载（默认：ONNX 模型权重） */
  isLarge?: (url: string) => boolean;
  /** 每块最多重试次数 */
  retries?: number;
  /** 超过这么久没有收到任何数据就断开重连（毫秒），默认 30 秒 */
  stallMs?: number;
}

const DEFAULT_LARGE = (url: string) => /\.onnx(_data(_\d+)?)?(\?|$)/.test(url);

/** 解析 "bytes 0-0/12345" 中的总大小 */
export function parseTotal(contentRange: string | null): number | null {
  const m = contentRange?.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export function createResumableFetch(opts: ResumableOptions = {}): typeof fetch {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const openCache = opts.openCache ?? (() => caches.open(PARTIAL_CACHE));
  const chunkSize = opts.chunkSize ?? 16 * 1024 * 1024;
  const isLarge = opts.isLarge ?? DEFAULT_LARGE;
  const retries = opts.retries ?? 6;
  const stallMs = opts.stallMs ?? 30_000;

  /** 带“卡死检测”的请求：每次 kick() 重新计时，超时则中止连接 */
  const watched = (url: string, init: RequestInit | undefined, range: string) => {
    const ac = new AbortController();
    let timer = setTimeout(() => ac.abort(new Error(m.err_stall({ s: stallMs / 1000 }))), stallMs);
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ac.abort(new Error(m.err_stall({ s: stallMs / 1000 }))), stallMs);
    };
    const signal = init?.signal ? AbortSignal.any([init.signal, ac.signal]) : ac.signal;
    const res = doFetch(url, { ...init, signal, headers: withRange(init?.headers, range) });
    return { res, kick, done: () => clearTimeout(timer) };
  };

  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!isLarge(url) || (init?.method && init.method !== 'GET')) return doFetch(input, init);

    // 探测总大小以及服务器是否支持 Range
    const p = watched(url, init, 'bytes=0-0');
    const probe = await p.res.finally(p.done);
    // 不支持 Range 时，探测请求本身就是完整响应（200）或错误（404 等），原样返回
    if (probe.status !== 206) return probe;
    const total = parseTotal(probe.headers.get('content-range'));
    await probe.body?.cancel();
    if (total === null) return doFetch(input, init);

    const cache = await openCache();
    const count = Math.ceil(total / chunkSize);
    // 文件大小也作为 key 的一部分：远端文件更新后不会误用旧分块
    const keyOf = (i: number) => `${url}${url.includes('?') ? '&' : '?'}__bilingo_size=${total}&__chunk=${i}`;

    /**
     * 下载第 i 块：收到的数据立即推给下游（进度条实时更新），全部收到后整块存入缓存。
     * 中途失败时只重新请求还没收到的字节，已推给下游的数据不会重复。
     */
    const streamChunk = async (i: number, controller: ReadableStreamDefaultController<Uint8Array>) => {
      const start = i * chunkSize;
      const end = Math.min(total, start + chunkSize) - 1;
      const size = end - start + 1;
      const parts: Uint8Array[] = [];
      let got = 0;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= retries && got < size; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** (attempt - 1))));
        try {
          const w = watched(url, init, `bytes=${start + got}-${end}`);
          try {
            const res = await w.res;
            if (res.status !== 206 || !res.body) throw new Error(`HTTP ${res.status}`);
            const reader = res.body.getReader();
            for (;;) {
              w.kick();
              const { done, value } = await reader.read();
              if (done) break;
              const piece = value.byteLength > size - got ? value.subarray(0, size - got) : value;
              parts.push(piece);
              got += piece.byteLength;
              controller.enqueue(piece);
              if (got >= size) {
                await reader.cancel();
                break;
              }
            }
            if (got < size) throw new Error(m.err_conn_closed());
          } finally {
            w.done();
          }
        } catch (e) {
          lastErr = e;
        }
      }
      if (got < size) {
        throw new Error(m.err_chunk({ i: i + 1, n: count, msg: (lastErr as Error)?.message ?? String(lastErr) }));
      }
      const buf = new Uint8Array(size);
      let off = 0;
      for (const p of parts) {
        buf.set(p, off);
        off += p.byteLength;
      }
      await cache.put(keyOf(i), new Response(buf));
    };

    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i >= count) {
          controller.close();
          // 完整文件即将由 Transformers.js 存入它自己的缓存，分块不再需要
          await Promise.all(Array.from({ length: count }, (_, k) => cache.delete(keyOf(k)))).catch(() => {});
          return;
        }
        const cached = await cache.match(keyOf(i));
        if (cached) controller.enqueue(new Uint8Array(await cached.arrayBuffer()));
        else await streamChunk(i, controller);
        i++;
      },
    });

    return new Response(body, {
      status: 200,
      headers: { 'content-length': String(total), 'content-type': 'application/octet-stream' },
    });
  };
}

function withRange(headers: HeadersInit | undefined, range: string): Headers {
  const h = new Headers(headers);
  h.set('Range', range);
  return h;
}

/** 删除所有未完成的分块 */
export async function clearPartialDownloads(): Promise<void> {
  await caches.delete(PARTIAL_CACHE);
}

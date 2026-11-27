import { describe, expect, it } from 'vitest';
import { createResumableFetch, parseTotal } from '@/local-llm/resumable-fetch';

const FILE = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
const URL_ = 'https://hf-mirror.com/org/model/resolve/main/onnx/model_q4f16.onnx_data';

/** 模拟支持 Range 的服务器；failFrom 之后的分块请求一律失败（模拟断网） */
function makeServer(opts: { range?: boolean; failFrom?: number; cutOnce?: number; stallOnce?: number } = {}) {
  let stall = opts.stallOnce;
  let cut = opts.cutOnce;
  const ranges: string[] = [];
  const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('Range');
    if (!range || opts.range === false) return Promise.resolve(new Response(FILE.slice(), { status: 200 }));
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
    const start = Number(a);
    const end = Number(b);
    ranges.push(range);
    if (opts.failFrom !== undefined && start >= opts.failFrom) return Promise.reject(new TypeError('network error'));
    if (stall !== undefined && start === stall) {
      // 模拟连接卡死：响应头到了，但数据永远不来（只有被 abort 时才结束）
      stall = undefined;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
        },
      });
      return Promise.resolve(new Response(body, { status: 206 }));
    }
    if (cut !== undefined && end > cut && start < cut) {
      // 模拟连接在 cut 处断开：只返回前半段然后报错
      const head = FILE.slice(start, cut);
      cut = undefined;
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (!sent) {
            sent = true;
            c.enqueue(head);
          } else c.error(new TypeError('connection reset'));
        },
      });
      return Promise.resolve(new Response(body, { status: 206 }));
    }
    return Promise.resolve(
      new Response(FILE.slice(start, end + 1), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${FILE.length}` },
      }),
    );
  }) as typeof fetch;
  return { fetchFn, ranges };
}

function memoryCache() {
  const store = new Map<string, ArrayBuffer>();
  const cache = {
    match: (k: string) => {
      const v = store.get(k);
      return Promise.resolve(v ? new Response(v.slice(0)) : undefined);
    },
    put: async (k: string, r: Response) => void store.set(k, await r.arrayBuffer()),
    delete: (k: string) => Promise.resolve(store.delete(k)),
    keys: () => Promise.resolve([]),
  };
  return { store, openCache: () => Promise.resolve(cache as unknown as Cache) };
}

const read = async (r: Response) => new Uint8Array(await r.arrayBuffer());

describe('resumable model download', () => {
  it('parses the total size from Content-Range', () => {
    expect(parseTotal('bytes 0-0/1085000000')).toBe(1085000000);
    expect(parseTotal('bytes */*')).toBeNull();
    expect(parseTotal(null)).toBeNull();
  });

  it('downloads in chunks and reassembles the exact bytes, then drops the chunks', async () => {
    const { fetchFn } = makeServer();
    const { store, openCache } = memoryCache();
    const f = createResumableFetch({ fetch: fetchFn, openCache, chunkSize: 300 });
    const res = await f(URL_);
    expect(res.headers.get('content-length')).toBe('1000');
    expect(await read(res)).toEqual(FILE);
    expect(store.size).toBe(0);
  });

  it('resumes after an interruption without re-downloading finished chunks', async () => {
    const first = makeServer({ failFrom: 600 });
    const { store, openCache } = memoryCache();
    const f1 = createResumableFetch({ fetch: first.fetchFn, openCache, chunkSize: 300, retries: 0 });
    await expect(read(await f1(URL_))).rejects.toThrow(/Failed to download model chunk/);
    expect(store.size).toBe(2); // 0-299、300-599 已保存

    const second = makeServer();
    const f2 = createResumableFetch({ fetch: second.fetchFn, openCache, chunkSize: 300 });
    expect(await read(await f2(URL_))).toEqual(FILE);
    // 只有探测请求和剩下的两块
    expect(second.ranges).toEqual(['bytes=0-0', 'bytes=600-899', 'bytes=900-999']);
  });

  it('continues a chunk from the byte where the connection dropped', async () => {
    const { fetchFn, ranges } = makeServer({ cutOnce: 450 });
    const { openCache } = memoryCache();
    const f = createResumableFetch({ fetch: fetchFn, openCache, chunkSize: 300, retries: 2 });
    expect(await read(await f(URL_))).toEqual(FILE);
    expect(ranges).toContain('bytes=450-599');
  });

  it('drops a stalled connection and retries it', async () => {
    const { fetchFn, ranges } = makeServer({ stallOnce: 300 });
    const { openCache } = memoryCache();
    const f = createResumableFetch({ fetch: fetchFn, openCache, chunkSize: 300, stallMs: 50 });
    expect(await read(await f(URL_))).toEqual(FILE);
    expect(ranges.filter((r) => r === 'bytes=300-599')).toHaveLength(2);
  });

  it('falls back to a normal download when the server ignores Range', async () => {
    const { fetchFn } = makeServer({ range: false });
    const { openCache } = memoryCache();
    const f = createResumableFetch({ fetch: fetchFn, openCache, chunkSize: 300 });
    expect(await read(await f(URL_))).toEqual(FILE);
  });

  it('passes small files straight through', async () => {
    const { fetchFn, ranges } = makeServer();
    const { openCache } = memoryCache();
    const f = createResumableFetch({ fetch: fetchFn, openCache, chunkSize: 300 });
    await f('https://hf-mirror.com/org/model/resolve/main/config.json');
    expect(ranges).toEqual([]);
  });
});

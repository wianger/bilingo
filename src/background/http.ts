import { m } from '@/shared/i18n';

export class TranslateError extends Error {
  constructor(
    message: string,
    public status = 0,
    public retryable = false,
  ) {
    super(message);
  }
}

export async function request(url: string, init: RequestInit, label: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new TranslateError(m.err_network({ label, msg: (e as Error).message }), 0, true);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = errorDetail(await res.text());
    } catch {}
    throw new TranslateError(
      `${label} HTTP ${res.status} ${detail}`.trim(),
      res.status,
      res.status === 429 || res.status >= 500,
    );
  }
  return res;
}

/** 错误响应的正文：JSON 原样（截断），HTML 错误页只取标题（例如 429 限流页），不把整页 HTML 显示给用户 */
export function errorDetail(body: string): string {
  const text = body.trim();
  if (/^<!doctype html|^<html/i.test(text)) {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
    return title ?? '';
  }
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

export async function withRetry<T>(fn: () => Promise<T>, tries = 3, baseDelay = 1000): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || !(e instanceof TranslateError) || !e.retryable) throw e;
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** i));
    }
  }
}

/** 简单的并发闸门 */
export class Limiter {
  private running = 0;
  private waiting: (() => void)[] = [];
  constructor(public limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

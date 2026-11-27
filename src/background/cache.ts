// 翻译结果持久化缓存（IndexedDB）：同一段文字不重复请求，节省 API 费用
import { openDB, type DBSchema } from 'idb';

interface CacheDB extends DBSchema {
  tx: { key: string; value: { k: string; v: string; t: number }; indexes: { t: number } };
}

const MAX_ENTRIES = 50_000;
const PRUNE_EVERY = 500;

const dbPromise = openDB<CacheDB>('bilingo-cache', 1, {
  upgrade(db) {
    db.createObjectStore('tx', { keyPath: 'k' }).createIndex('t', 't');
  },
});

let writes = 0;

export async function hashKey(parts: string[]): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\u0001')));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function cacheGetMany(keys: string[]): Promise<(string | undefined)[]> {
  const db = await dbPromise;
  const tx = db.transaction('tx', 'readonly');
  const out = await Promise.all(keys.map((k) => tx.store.get(k)));
  await tx.done;
  return out.map((r) => r?.v);
}

export async function cachePutMany(entries: [string, string][]): Promise<void> {
  if (!entries.length) return;
  const db = await dbPromise;
  const tx = db.transaction('tx', 'readwrite');
  const t = Date.now();
  await Promise.all(entries.map(([k, v]) => tx.store.put({ k, v, t })));
  await tx.done;
  writes += entries.length;
  if (writes >= PRUNE_EVERY) {
    writes = 0;
    prune().catch(() => {});
  }
}

async function prune(): Promise<void> {
  const db = await dbPromise;
  const count = await db.count('tx');
  if (count <= MAX_ENTRIES) return;
  let toDelete = count - Math.floor(MAX_ENTRIES * 0.8);
  const tx = db.transaction('tx', 'readwrite');
  let cursor = await tx.store.index('t').openCursor();
  while (cursor && toDelete-- > 0) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function cacheClear(): Promise<void> {
  await (await dbPromise).clear('tx');
}

/**
 * IndexedDB 极简封装。库结构即应用直接使用的存储（media 表保存本地上传的图片 / 视频，
 * 运行时由 src/local/media.ts 解析成 blob URL 显示，不再依赖 Service Worker）。
 */
export const DB_NAME = 'timeline-record';
export const DB_VERSION = 1;

export type StoreName = 'types' | 'regions' | 'nodes' | 'comments' | 'media' | 'kv';

const STORES: [StoreName, string][] = [
  ['types', 'id'],
  ['regions', 'id'],
  ['nodes', 'id'],
  ['comments', 'id'],
  ['media', 'id'],
  ['kv', 'key'],
];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB，无法保存数据'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('无法打开本地数据库'));
    };
    req.onblocked = () => reject(new Error('本地数据库被其他标签页占用，请关闭其他标签页后重试'));
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return wrap(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openDb();
  return wrap(db.transaction(store, 'readonly').objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function getAllKeys(store: StoreName): Promise<string[]> {
  const db = await openDb();
  return wrap(db.transaction(store, 'readonly').objectStore(store).getAllKeys() as IDBRequest<string[]>);
}

export interface WriteOp {
  store: StoreName;
  put?: unknown[];
  del?: string[];
  clear?: boolean;
}

/** 在一个事务中执行多项写入，事务提交后才返回 */
export async function write(ops: WriteOp[]): Promise<void> {
  const real = ops.filter((o) => o.clear || o.put?.length || o.del?.length);
  if (!real.length) return;
  const db = await openDb();
  const names = [...new Set(real.map((o) => o.store))];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('写入本地数据库失败'));
    for (const op of real) {
      const s = tx.objectStore(op.store);
      if (op.clear) s.clear();
      for (const k of op.del ?? []) s.delete(k);
      for (const v of op.put ?? []) s.put(v);
    }
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const r = await get<{ key: string; value: T }>('kv', key);
  return r?.value;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await write([{ store: 'kv', put: [{ key, value }] }]);
}

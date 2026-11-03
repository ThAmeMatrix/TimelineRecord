/**
 * 浏览器端的联网请求：超时、取消、JSONP、按站点限速，以及可选的跨域代理。
 *
 * 纯前端无法直接访问没有开放跨域（CORS）的网站（豆瓣、必应、百度图片等）。
 * - 开发 / 预览模式（npm run dev / npm run preview）自带一个本地代理：./cors-proxy?url=
 * - 部署为静态网站后，可在「设置 → 数据 → 跨域代理」里填写自己的代理地址
 */

export class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

export class CodeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/* ------------------------------ 代理配置 ------------------------------ */

const PROXY_KEY = 'tl-proxy';
const BUILTIN = 'cors-proxy?url={url}';
let builtinOk = false;
let proxyListeners: (() => void)[] = [];

export function customProxy(): string {
  try {
    return localStorage.getItem(PROXY_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setCustomProxy(v: string): void {
  try {
    if (v.trim()) localStorage.setItem(PROXY_KEY, v.trim());
    else localStorage.removeItem(PROXY_KEY);
  } catch {
    /* ignore */
  }
  for (const fn of proxyListeners) fn();
}

export function onProxyChange(fn: () => void): () => void {
  proxyListeners.push(fn);
  return () => {
    proxyListeners = proxyListeners.filter((x) => x !== fn);
  };
}

export function builtinProxyAvailable(): boolean {
  return builtinOk;
}

/** 当前生效的代理模板（含 {url} 占位符），没有则返回 null */
export function proxyTemplate(): string | null {
  const c = customProxy();
  if (c) return c.includes('{url}') ? c : `${c}{url}`;
  return builtinOk ? BUILTIN : null;
}

export function hasProxy(): boolean {
  return proxyTemplate() != null;
}

export function proxied(url: string): string {
  const t = proxyTemplate();
  if (!t) throw new CodeError('NO_PROXY', '需要跨域代理（见 设置 → 数据）');
  return t.replace('{url}', encodeURIComponent(url));
}

/** 探测开发/预览服务器自带的本地代理 */
export async function detectBuiltinProxy(): Promise<boolean> {
  try {
    const res = await fetch('cors-proxy?ping=1', { cache: 'no-store' });
    builtinOk = res.ok && (await res.text()).trim() === 'timeline-proxy-ok';
  } catch {
    builtinOk = false;
  }
  for (const fn of proxyListeners) fn();
  return builtinOk;
}

/** 测试某个代理模板是否可用 */
export async function testProxy(template: string): Promise<string> {
  const t = template.includes('{url}') ? template : `${template}{url}`;
  const target = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=%E4%B8%89%E4%BD%93&bk_length=50';
  const res = await fetchWithTimeout(t.replace('{url}', encodeURIComponent(target)), {}, 10000);
  if (!res.ok) throw new HttpError(res.status);
  const j = await res.json();
  if (!j || typeof j !== 'object' || !('title' in j)) throw new Error('代理返回的内容不正确');
  return '代理可用';
}

/* ------------------------------ 按站点限速 ------------------------------ */

/** 豆瓣对突发请求会静默返回空结果：串行化并保持间隔 */
const POLICIES = [{ key: 'douban', test: (h: string) => h === 'douban.com' || h.endsWith('.douban.com'), concurrency: 1, gap: 2000 }];

interface Bucket {
  active: number;
  last: number;
  queue: { resolve: (release: () => void) => void; timer: number | null }[];
  timer: number | null;
}
const buckets = new Map<string, Bucket>();

function pump(b: Bucket, gap: number, concurrency: number) {
  if (b.timer != null) return;
  while (b.active < concurrency && b.queue.length) {
    const wait = b.last + gap - Date.now();
    if (wait > 0) {
      b.timer = window.setTimeout(() => {
        b.timer = null;
        pump(b, gap, concurrency);
      }, wait);
      return;
    }
    const entry = b.queue.shift()!;
    if (entry.timer != null) window.clearTimeout(entry.timer);
    b.active++;
    b.last = Date.now();
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      b.active--;
      b.last = Date.now();
      pump(b, gap, concurrency);
    });
  }
}

function acquire(url: string, priority: 'high' | 'normal', maxWait: number): Promise<() => void> {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return Promise.resolve(() => {});
  }
  const policy = POLICIES.find((p) => p.test(host));
  if (!policy) return Promise.resolve(() => {});
  let b = buckets.get(policy.key);
  if (!b) {
    b = { active: 0, last: 0, queue: [], timer: null };
    buckets.set(policy.key, b);
  }
  const bucket = b;
  return new Promise((resolve, reject) => {
    const entry: Bucket['queue'][number] = { resolve, timer: null };
    if (maxWait > 0) {
      entry.timer = window.setTimeout(() => {
        const i = bucket.queue.indexOf(entry);
        if (i < 0) return;
        bucket.queue.splice(i, 1);
        reject(new CodeError('QUEUE_TIMEOUT', '请求排队超时（该站点限流中）'));
      }, maxWait);
    }
    if (priority === 'high') bucket.queue.unshift(entry);
    else bucket.queue.push(entry);
    pump(bucket, policy.gap, policy.concurrency);
  });
}

/* ------------------------------ 请求 ------------------------------ */

async function fetchWithTimeout(url: string, init: RequestInit, timeout: number, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeout);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (timedOut) throw new CodeError('TIMEOUT', '请求超时');
    throw err;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  signal?: AbortSignal;
  parse?: 'json' | 'text' | 'blob';
  /** never：只直连；fallback：直连失败（跨域/网络）时改走代理；always：只走代理 */
  proxy?: 'never' | 'fallback' | 'always';
  priority?: 'high' | 'normal';
  maxWait?: number;
}

export async function request<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', headers, body, timeout = 9000, signal, parse = 'json', proxy = 'never', priority = 'normal', maxWait = 0 } = opts;
  const release = await acquire(url, priority, maxWait);
  try {
    const init: RequestInit = { method, headers, body, credentials: 'omit', referrerPolicy: 'no-referrer' };
    let res: Response;
    if (proxy === 'always') {
      res = await fetchWithTimeout(proxied(url), init, timeout + 3000, signal);
    } else {
      try {
        res = await fetchWithTimeout(url, init, timeout, signal);
      } catch (err) {
        if (proxy !== 'fallback' || !hasProxy() || signal?.aborted || !(err instanceof TypeError)) throw err;
        res = await fetchWithTimeout(proxied(url), init, timeout + 3000, signal);
      }
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new HttpError(res.status);
    }
    if (parse === 'blob') return (await res.blob()) as T;
    const text = await res.text();
    return (parse === 'json' ? JSON.parse(text) : text) as T;
  } finally {
    release();
  }
}

/* ------------------------------ JSONP ------------------------------ */

let jsonpSeq = 0;

/** 通过 <script> 加载支持 callback 参数的接口（无需 CORS） */
export function jsonp<T = unknown>(url: string, { timeout = 9000, signal, param = 'callback' }: { timeout?: number; signal?: AbortSignal; param?: string } = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const name = `__tl_jsonp_${Date.now().toString(36)}_${++jsonpSeq}`;
    const script = document.createElement('script');
    const w = window as unknown as Record<string, unknown>;
    let done = false;
    const cleanup = () => {
      done = true;
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      script.remove();
      // 晚到的回调不能报错
      w[name] = () => {};
      window.setTimeout(() => delete w[name], 30000);
    };
    const onAbort = () => {
      if (done) return;
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      if (done) return;
      cleanup();
      reject(new CodeError('TIMEOUT', '请求超时'));
    }, timeout);
    w[name] = (data: T) => {
      if (done) return;
      cleanup();
      resolve(data);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    script.src = `${url}${url.includes('?') ? '&' : '?'}${param}=${name}`;
    script.referrerPolicy = 'no-referrer';
    script.async = true;
    script.onerror = () => {
      if (done) return;
      cleanup();
      reject(new CodeError('NETWORK', '网络不可达'));
    };
    document.head.appendChild(script);
  });
}

/* ------------------------------ 错误描述 ------------------------------ */

export function describeError(err: unknown): string {
  if (!err) return '未知错误';
  const e = err as Error & { code?: string };
  if (e instanceof CodeError) return e.message;
  if (e instanceof HttpError) return `HTTP ${e.status}`;
  if (e instanceof SyntaxError) return '返回数据无法解析';
  if (e.name === 'AbortError') return '已取消';
  if (e instanceof TypeError) return hasProxy() ? '网络不可达' : '网络不可达或被跨域拦截';
  return e.message || String(err);
}

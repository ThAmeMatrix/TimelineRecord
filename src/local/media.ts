import { useEffect, useState } from 'react';
import * as idb from './idb';
import { hasProxy, proxied } from './http';
import { newId } from './util';

/**
 * 本地媒体以相对地址 media/<id> 引用，运行时从 IndexedDB 取出 blob 生成 object URL 显示。
 * 这样无论用 http 打开还是直接双击 index.html（file://），图片/视频都能正常显示，且不需要 Service Worker。
 */
export const MEDIA_PREFIX = 'media/';

const HOTLINK_HOSTS = [/(^|\.)doubanio\.com$/, /(^|\.)douban\.com$/];
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
/** 远程图片的显示地址：防盗链图床在有代理时走代理 */
export function displayUrl(url: string): string {
  if (!/^https?:/i.test(url)) return url;
  const h = hostOf(url);
  if (hasProxy() && HOTLINK_HOSTS.some((re) => re.test(h))) return proxied(url);
  return url;
}

export interface MediaRecord {
  id: string;
  blob: Blob;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'application/pdf': 'pdf',
};

function extOf(name: string, mime: string): string {
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
  return fromName || MIME_EXT[mime] || 'bin';
}

export function mediaUrl(id: string): string {
  return MEDIA_PREFIX + id;
}

/** 从地址中取出本地媒体 id（不是本地媒体则返回 null） */
export function mediaIdOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let s = String(url);
  try {
    if (/^https?:/i.test(s)) {
      const u = new URL(s);
      if (u.origin !== location.origin) return null;
      s = u.pathname;
    }
  } catch {
    return null;
  }
  const i = s.indexOf(MEDIA_PREFIX);
  if (i < 0 || (i > 0 && s[i - 1] !== '/')) return null;
  const id = decodeURIComponent(s.slice(i + MEDIA_PREFIX.length).split(/[?#]/)[0]);
  return id && !id.includes('/') ? id : null;
}

export async function saveMedia(blob: Blob, name = '', prefix = 'm'): Promise<MediaRecord> {
  const mime = blob.type || 'application/octet-stream';
  const id = `${prefix}_${newId()}.${extOf(name, mime)}`;
  const rec: MediaRecord = { id, blob, name: name || id, mime, size: blob.size, createdAt: Date.now() };
  await idb.write([{ store: 'media', put: [rec] }]);
  return rec;
}

export async function deleteMedia(urls: (string | null | undefined)[]): Promise<void> {
  const ids = [...new Set(urls.map(mediaIdOf).filter((x): x is string => !!x))];
  if (ids.length) await idb.write([{ store: 'media', del: ids }]);
}

export function listMedia(): Promise<MediaRecord[]> {
  return idb.getAll<MediaRecord>('media');
}

/** 在一段文本（评论 Markdown / 节点字段）中找出所有引用到的本地媒体 id */
export function collectMediaIds(text: string, into: Set<string>): void {
  const re = /media\/([A-Za-z0-9_\-.%]+)/g;
  for (const m of String(text ?? '').matchAll(re)) {
    try {
      into.add(decodeURIComponent(m[1]));
    } catch {
      into.add(m[1]);
    }
  }
}

/* ------------------------- 本地媒体：blob URL 解析 ------------------------- */

const blobCache = new Map<string, string>();

/** 把 media/<id> 或远程地址解析成可直接用于 <img>/<video> 的 URL（本地媒体返回 blob URL） */
export async function resolveMediaUrl(src: string | null | undefined): Promise<string | null> {
  if (!src) return null;
  if (!src.startsWith(MEDIA_PREFIX)) return displayUrl(src);
  const id = mediaIdOf(src);
  if (!id) return displayUrl(src);
  const cached = blobCache.get(id);
  if (cached) return cached;
  try {
    const rec = await idb.get<MediaRecord>('media', id);
    if (!rec || !rec.blob) return null;
    const url = URL.createObjectURL(rec.blob);
    blobCache.set(id, url);
    return url;
  } catch {
    return null;
  }
}

/** 组件中获取媒体显示地址（远程地址原样返回，本地媒体异步解析为 blob URL） */
export function useMediaUrl(src: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() => (src && !src.startsWith(MEDIA_PREFIX) ? displayUrl(src) : null));
  useEffect(() => {
    let alive = true;
    if (!src) {
      setUrl(null);
      return;
    }
    if (!src.startsWith(MEDIA_PREFIX)) {
      setUrl(displayUrl(src));
      return;
    }
    void resolveMediaUrl(src).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [src]);
  return url;
}

/** 把一段已渲染的 HTML 里的本地媒体引用（img src / video src / poster）替换成 blob URL */
export function hydrateMedia(root: HTMLElement): void {
  const els = root.querySelectorAll<HTMLElement>('img[src^="media/"], video[src^="media/"], [poster^="media/"]');
  els.forEach((el) => {
    const apply = (attr: string) => {
      const v = el.getAttribute(attr);
      if (!v || !v.startsWith(MEDIA_PREFIX)) return;
      const id = mediaIdOf(v);
      if (!id) return;
      const cached = blobCache.get(id);
      if (cached) el.setAttribute(attr, cached);
      else void resolveMediaUrl(v).then((u) => u && el.setAttribute(attr, u));
    };
    apply('src');
    apply('poster');
  });
}

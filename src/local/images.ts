import { CodeError, hasProxy, proxied } from './http';
import { saveMedia, displayUrl } from './media';

export { displayUrl };

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** 有防盗链的图床：浏览器直接显示需要代理 */
const HOTLINK_HOSTS = [/(^|\.)doubanio\.com$/, /(^|\.)douban\.com$/];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isImageBlob(b: Blob): boolean {
  return b.size > 0 && (b.type.startsWith('image/') || b.type === '' || b.type === 'application/octet-stream' || b.type === 'binary/octet-stream');
}

async function tryFetch(url: string, timeout: number): Promise<Blob> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors' });
    if (!res.ok) throw new CodeError('HTTP', `图片下载失败（HTTP ${res.status}）`);
    const blob = await res.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw new CodeError('TOO_LARGE', '图片过大');
    if (!isImageBlob(blob)) throw new CodeError('NOT_IMAGE', '返回内容不是图片');
    return blob;
  } catch (err) {
    if (ctrl.signal.aborted) throw new CodeError('TIMEOUT', '图片下载超时');
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

/** 下载远程图片：先直连（需对方允许跨域），失败再走代理 */
export async function fetchImage(url: string, timeout = 15000): Promise<Blob> {
  if (!/^https?:\/\//i.test(url)) throw new CodeError('BAD_URL', '仅支持 http/https 图片地址');
  const hot = HOTLINK_HOSTS.some((re) => re.test(hostOf(url)));
  let firstErr: unknown = null;
  if (!hot || !hasProxy()) {
    try {
      return await tryFetch(url, timeout);
    } catch (err) {
      firstErr = err;
    }
  }
  if (hasProxy()) return tryFetch(proxied(url), timeout + 4000);
  throw firstErr instanceof CodeError ? firstErr : new CodeError('CORS', '该图片不允许跨域下载');
}

/** 不下载、只确认图片能显示（用于无法跨域下载的图片：直接引用远程地址） */
export function probeImage(url: string, timeout = 12000): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    const t = window.setTimeout(() => {
      img.src = '';
      reject(new CodeError('TIMEOUT', '图片加载超时'));
    }, timeout);
    img.onload = () => {
      window.clearTimeout(t);
      if (img.naturalWidth < 16 || img.naturalHeight < 16) reject(new CodeError('NOT_IMAGE', '图片无效'));
      else resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      window.clearTimeout(t);
      reject(new CodeError('LOAD', '图片无法加载'));
    };
    img.src = displayUrl(url);
  });
}

async function decode(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    return img;
  } catch {
    throw new CodeError('DECODE', '不支持的图片格式');
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (!b) return reject(new CodeError('ENCODE', '图片编码失败'));
        if (b.type === 'image/webp') return resolve(b);
        // 浏览器不支持 webp 编码时退回 jpeg
        canvas.toBlob((j) => (j ? resolve(j) : reject(new CodeError('ENCODE', '图片编码失败'))), 'image/jpeg', quality);
      },
      'image/webp',
      quality,
    );
  });
}

function resize(img: HTMLImageElement, maxW: number, maxH: number): HTMLCanvasElement {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const k = Math.min(1, maxW / w, maxH / h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function dominantColor(img: HTMLImageElement): string {
  try {
    const c = document.createElement('canvas');
    c.width = 24;
    c.height = 24;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, 24, 24);
    const d = ctx.getImageData(0, 0, 24, 24).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let wsum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const max = Math.max(d[i], d[i + 1], d[i + 2]);
      const min = Math.min(d[i], d[i + 1], d[i + 2]);
      // 偏向饱和度高的像素，避免主色被黑白背景冲淡
      const w = 0.2 + (max - min) / 255;
      r += d[i] * w;
      g += d[i + 1] * w;
      b += d[i + 2] * w;
      wsum += w;
    }
    if (!wsum) return '';
    return `#${[r, g, b].map((v) => Math.round(v / wsum).toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return '';
  }
}

export interface SavedCover {
  cover: string;
  coverThumb: string;
  coverColor: string;
}

/** 保存封面：转成 webp，生成缩略图并提取主色，写入本地媒体库 */
export async function saveCoverBlob(nodeId: string, blob: Blob): Promise<SavedCover> {
  if (blob.size > MAX_IMAGE_BYTES) throw new CodeError('TOO_LARGE', '图片过大（上限 25MB）');
  const img = await decode(blob);
  const color = dominantColor(img);
  const big = await toBlob(resize(img, 900, 1400), 0.86);
  const thumb = await toBlob(resize(img, 320, 480), 0.8);
  const a = await saveMedia(big, `cover.${big.type === 'image/webp' ? 'webp' : 'jpg'}`, `cover-${nodeId}`);
  const b = await saveMedia(thumb, `thumb.${thumb.type === 'image/webp' ? 'webp' : 'jpg'}`, `thumb-${nodeId}`);
  return { cover: `media/${a.id}`, coverThumb: `media/${b.id}`, coverColor: color };
}

/**
 * 从远程地址设置封面：能下载就保存到本地；对方不允许跨域时，确认能显示后直接引用远程地址。
 */
export async function saveCoverFromUrl(nodeId: string, url: string): Promise<SavedCover & { remote: boolean }> {
  try {
    const blob = await fetchImage(url);
    return { ...(await saveCoverBlob(nodeId, blob)), remote: false };
  } catch (err) {
    const code = (err as CodeError).code;
    if (code === 'TOO_LARGE' || code === 'NOT_IMAGE' || code === 'BAD_URL') throw err;
    await probeImage(url);
    return { cover: url, coverThumb: url, coverColor: '', remote: true };
  }
}

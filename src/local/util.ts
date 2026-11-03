import { titleKey } from '../lib/text';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function newId(prefix = ''): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return prefix + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  if (s.length < 2) {
    if (s) out.set(s, 1);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** 0..1 的标题相似度：完全相同=1，包含关系按长度比例，其余用二元组 Dice 系数 */
export function similarity(a: string, b: string): number {
  a = titleKey(a ?? '');
  b = titleKey(b ?? '');
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    return 0.62 + 0.33 * ratio;
  }
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) {
    total += n;
    const m = B.get(g);
    if (m) inter += Math.min(n, m);
  }
  for (const [, n] of B) total += n;
  return total ? ((2 * inter) / total) * 0.85 : 0;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string): string {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function stripHtml(s: string | null | undefined): string {
  return decodeEntities(
    String(s ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function clip(s: string | null | undefined, n = 3000): string {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 把评论的 Markdown 粗略转成纯文本，用于全文搜索 */
export function markdownToText(md: string): string {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

export function isValidDate(s: unknown): s is string {
  const m = DATE_RE.exec(String(s ?? ''));
  if (!m) return false;
  const y = Number(m[1]);
  if (y < 1000) return false;
  if (!m[2]) return true;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return false;
  if (!m[3]) return true;
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function periodStart(s: string): number {
  const m = DATE_RE.exec(s)!;
  return Date.UTC(Number(m[1]), Number(m[2] || 1) - 1, Number(m[3] || 1));
}

export function periodEnd(s: string): number {
  const m = DATE_RE.exec(s)!;
  const y = Number(m[1]);
  if (m[3]) return Date.UTC(y, Number(m[2]) - 1, Number(m[3]) + 1);
  if (m[2]) return Date.UTC(y, Number(m[2]), 1);
  return Date.UTC(y + 1, 0, 1);
}

/* ------------------------------ 本地事件 ------------------------------ */

export type BusEvent =
  | { type: 'node'; node: import('../types').TLNode }
  | { type: 'node-removed'; id: string }
  | { type: 'taxonomy' }
  | { type: 'reload' }
  | { type: 'comments'; nodeId: string }
  | { type: 'dirty'; dirty: boolean };

type Listener = (e: BusEvent) => void;
const listeners = new Set<Listener>();

export const bus = {
  on(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit(e: BusEvent): void {
    for (const fn of listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error('[bus]', err);
      }
    }
  },
};

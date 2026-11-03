const PUNCT = /[\s\u3000·・•‧\-—–_:：,，.。!！?？'"“”‘’`~《》〈〉「」『』【】[\]()（）<>/\\|+&*#@$%^=;；]/g;

/** 同名判定用的标题键：忽略大小写、全半角与标点 */
export function titleKey(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(PUNCT, '');
}

export function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

export function splitTerms(q: string): string[] {
  return norm(q)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 在文本中找到第一个命中词附近的片段，返回 [前, 命中, 后] */
export function snippet(text: string, terms: string[], radius = 26): [string, string, string] | null {
  if (!text) return null;
  const lower = norm(text);
  let best = -1;
  let hit = '';
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (best < 0 || i < best)) {
      best = i;
      hit = t;
    }
  }
  if (best < 0) return null;
  const from = Math.max(0, best - radius);
  const to = Math.min(text.length, best + hit.length + radius);
  return [
    (from > 0 ? '…' : '') + text.slice(from, best).replace(/\s+/g, ' '),
    text.slice(best, best + hit.length),
    text.slice(best + hit.length, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : ''),
  ];
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 根据背景色返回可读的前景色 */
export function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fff';
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111' : '#fff';
}

export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(148,163,184,${alpha})`;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

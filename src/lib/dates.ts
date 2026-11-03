export const DAY = 86_400_000;
export const YEAR = 365.2425 * DAY;

const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

export type Precision = 'year' | 'month' | 'day';

export interface DateParts {
  y: number;
  m: number;
  d: number;
}

export function parseParts(s: string): DateParts | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), m: m[2] ? Number(m[2]) : 0, d: m[3] ? Number(m[3]) : 0 };
}

/** 年份限定在 1000~2999，Date.UTC 可直接处理月/日溢出 */
export function utc(y: number, m = 1, d = 1): number {
  return Date.UTC(y, m - 1, d);
}

/** 时间段起点（UTC 毫秒） */
export function dateStart(s: string): number {
  const p = parseParts(s);
  if (!p) return 0;
  return utc(p.y, p.m || 1, p.d || 1);
}

/** 时间段终点（不含） */
export function dateEnd(s: string): number {
  const p = parseParts(s);
  if (!p) return 0;
  if (p.d) return utc(p.y, p.m, p.d + 1);
  if (p.m) return utc(p.y, p.m + 1, 1);
  return utc(p.y + 1, 1, 1);
}

export function precisionOf(s: string): Precision {
  const p = parseParts(s);
  if (!p || !p.m) return 'year';
  return p.d ? 'day' : 'month';
}

export function formatDate(s: string): string {
  const p = parseParts(s);
  if (!p) return s;
  if (p.d) return `${p.y}年${p.m}月${p.d}日`;
  if (p.m) return `${p.y}年${p.m}月`;
  return `${p.y}年`;
}

export function formatShort(s: string): string {
  const p = parseParts(s);
  if (!p) return s;
  if (p.d) return `${p.y}.${String(p.m).padStart(2, '0')}.${String(p.d).padStart(2, '0')}`;
  if (p.m) return `${p.y}.${String(p.m).padStart(2, '0')}`;
  return String(p.y);
}

export function formatRange(start: string, end: string | null): string {
  if (!end) return formatDate(start);
  const a = parseParts(start);
  const b = parseParts(end);
  if (a && b && a.y === b.y && a.m && b.m) {
    return `${formatDate(start)} – ${b.d ? `${b.m}月${b.d}日` : `${b.m}月`}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function valid(y: number, m: number, d: number): boolean {
  if (y < 1000 || y > 2999) return false;
  if (!m) return true;
  if (m < 1 || m > 12) return false;
  if (!d) return true;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function toDateString(y: number, m = 0, d = 0): string {
  if (!m) return String(y);
  if (!d) return `${y}-${String(m).padStart(2, '0')}`;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 宽松解析用户输入：2013 / 2013-4 / 2013/4/7 / 2013.4.7 / 2013年4月7日 / 20130407 */
export function parseDateInput(input: string): string | null {
  const raw = input
    .trim()
    .replace(/[年月/.\\]/g, '-')
    .replace(/[日号]/g, '')
    .replace(/\s+/g, '')
    .replace(/-+$/, '');
  if (!raw) return null;
  let m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(raw);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})?$/.exec(raw);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : 0;
  const d = m[3] ? Number(m[3]) : 0;
  if (!valid(y, mo, d)) return null;
  return toDateString(y, mo, d);
}

export function todayString(): string {
  const d = new Date();
  return toDateString(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** 当前时刻在时间轴上的位置（本地日期 + 当天已过去的比例） */
export function nowOnAxis(): number {
  const d = new Date();
  const start = utc(d.getFullYear(), d.getMonth() + 1, d.getDate());
  const frac = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
  return start + frac * DAY;
}

/** 时间轴上的毫秒 → 指定精度的日期字符串 */
export function msToDateString(ms: number, precision: Precision): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (precision === 'year') return String(y);
  if (precision === 'month') return toDateString(y, d.getUTCMonth() + 1);
  return toDateString(y, d.getUTCMonth() + 1, d.getUTCDate());
}

export function compareDateStr(a: string, b: string): number {
  return dateStart(a) - dateStart(b) || dateEnd(a) - dateEnd(b);
}

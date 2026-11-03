import { DAY, YEAR, utc } from './dates';

export interface Tick {
  t: number;
  label: string;
  /** 是否为年份/月份等更粗一级的边界 */
  strong: boolean;
}

interface Level {
  unit: 'day' | 'month' | 'year';
  step: number;
  approx: number;
}

const LEVELS: Level[] = [
  { unit: 'day', step: 1, approx: DAY },
  { unit: 'day', step: 2, approx: 2 * DAY },
  { unit: 'day', step: 5, approx: 5 * DAY },
  { unit: 'month', step: 1, approx: YEAR / 12 },
  { unit: 'month', step: 3, approx: YEAR / 4 },
  { unit: 'month', step: 6, approx: YEAR / 2 },
  { unit: 'year', step: 1, approx: YEAR },
  { unit: 'year', step: 2, approx: 2 * YEAR },
  { unit: 'year', step: 5, approx: 5 * YEAR },
  { unit: 'year', step: 10, approx: 10 * YEAR },
  { unit: 'year', step: 20, approx: 20 * YEAR },
  { unit: 'year', step: 50, approx: 50 * YEAR },
  { unit: 'year', step: 100, approx: 100 * YEAR },
  { unit: 'year', step: 200, approx: 200 * YEAR },
  { unit: 'year', step: 500, approx: 500 * YEAR },
];

function majorOf(minor: Level): Level {
  if (minor.unit === 'day') return { unit: 'month', step: 1, approx: YEAR / 12 };
  if (minor.unit === 'month') return { unit: 'year', step: 1, approx: YEAR };
  if (minor.step < 10) return { unit: 'year', step: 10, approx: 10 * YEAR };
  if (minor.step < 100) return { unit: 'year', step: 100, approx: 100 * YEAR };
  return { unit: 'year', step: 1000, approx: 1000 * YEAR };
}

function parts(t: number) {
  const d = new Date(t);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function generate(level: Level, from: number, to: number, label: (y: number, m: number, d: number) => string): Tick[] {
  const out: Tick[] = [];
  const p = parts(from);
  if (level.unit === 'year') {
    let y = Math.floor(p.y / level.step) * level.step;
    for (let guard = 0; guard < 400; guard++, y += level.step) {
      const t = utc(y, 1, 1);
      if (t > to) break;
      if (t >= from - level.approx) out.push({ t, label: label(y, 1, 1), strong: false });
    }
  } else if (level.unit === 'month') {
    let y = p.y;
    let m = Math.floor((p.m - 1) / level.step) * level.step + 1;
    for (let guard = 0; guard < 600; guard++) {
      const t = utc(y, m, 1);
      if (t > to) break;
      out.push({ t, label: label(y, m, 1), strong: m === 1 });
      m += level.step;
      if (m > 12) {
        m -= 12;
        y++;
      }
    }
  } else {
    let y = p.y;
    let m = p.m;
    let d = 1;
    for (let guard = 0; guard < 800; guard++) {
      const t = utc(y, m, d);
      if (t > to) break;
      if (t >= from - DAY * level.step) out.push({ t, label: label(y, m, d), strong: d === 1 });
      d += level.step;
      const monthDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
      // 步长 > 1 时，月末距离下月 1 号太近的刻度跳过
      if (d > monthDays || (level.step > 1 && d > monthDays - Math.ceil(level.step / 2))) {
        d = 1;
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }
    }
  }
  return out;
}

export interface TickSet {
  minor: Tick[];
  major: Tick[];
}

/** 根据当前缩放生成刻度：minor 间距不小于 minPx */
export function computeTicks(from: number, to: number, msPerPx: number, minPx = 70): TickSet {
  const minor = LEVELS.find((l) => l.approx / msPerPx >= minPx) ?? LEVELS[LEVELS.length - 1];
  const major = majorOf(minor);
  const minorTicks = generate(minor, from, to, (y, m, d) => {
    if (minor.unit === 'day') return `${d}日`;
    if (minor.unit === 'month') return `${m}月`;
    return `${y}`;
  });
  const majorTicks = generate(major, from - major.approx, to, (y, m) => {
    if (major.unit === 'month') return `${y}年${m}月`;
    if (major.step === 10) return `${y}年代`;
    return `${y}年`;
  }).map((t) => ({ ...t, strong: true }));
  return { minor: minorTicks, major: majorTicks };
}

/** 双击空白处新建节点时，按缩放推断日期精度 */
export function precisionForScale(msPerPx: number): 'day' | 'month' | 'year' {
  if (msPerPx * 40 < DAY * 3) return 'day';
  if (msPerPx * 40 < YEAR / 4) return 'month';
  return 'year';
}

import type { Density, Orientation, TLNode, TLType } from '../types';

export interface Item {
  n: TLNode;
  t0: number;
  /** 时间段终点（不含）；单点节点为 null */
  t1: number | null;
}

export type Lod = 'poster' | 'card' | 'chip' | 'dot';
export const LODS: Lod[] = ['poster', 'card', 'chip', 'dot'];

export interface Dim {
  /** 卡片沿时间轴的尺寸 */
  along: number;
  /** 卡片沿列轴的尺寸 */
  across: number;
  /** 列（泳道）间距 */
  lane: number;
}

/** 各细节层级的卡片尺寸（卡片本身的宽高固定：海报 112×206、卡片 210×68、紧凑 146×28、圆点 16×16） */
export const DIMS: Record<Orientation, Record<Lod, Dim>> = {
  h: {
    poster: { along: 112, across: 206, lane: 222 },
    card: { along: 210, across: 68, lane: 80 },
    chip: { along: 146, across: 28, lane: 34 },
    dot: { along: 16, across: 16, lane: 20 },
  },
  v: {
    poster: { along: 206, across: 112, lane: 130 },
    card: { along: 68, across: 210, lane: 224 },
    chip: { along: 28, across: 146, lane: 156 },
    dot: { along: 16, across: 16, lane: 20 },
  },
};

/** 左侧留给所有条带的总内边距（列轴方向） */
export const CROSS_PAD = 18;
/** 每个分组条带左侧的标题条宽度（列轴方向） */
export const BAND_HEAD = 28;
export const BAND_GAP = 12;
const GAP = 10;

/** 把缩放量化成 √2 的档位：同一档位内布局不变，缩放时不会每帧重排 */
export function bucketOf(msPerPx: number): number {
  return Math.floor(Math.log2(msPerPx) * 2);
}

export function bucketMs(bucket: number): number {
  return 2 ** ((bucket + 1) / 2);
}

export interface Placed {
  item: Item;
  lane: number;
  /** 沿列轴（水平）的位置（像素） */
  x: number;
  band: number;
}

export interface Band {
  key: string;
  label: string;
  color: string;
  icon: string;
  /** 沿列轴（水平）的起始位置 */
  x: number;
  /** 沿列轴（水平）的宽度（含标题条与所有列） */
  w: number;
  lanes: number;
  count: number;
}

export interface Layout {
  lod: Lod;
  /** 按 t0 排序 */
  placed: Placed[];
  byId: Map<string, Placed>;
  bands: Band[];
  /** 沿列轴（水平）的总可用宽度 */
  cross: number;
  /** 最长时间段（毫秒），用于可见性查询 */
  reach: number;
}

interface Group {
  key: string;
  label: string;
  color: string;
  icon: string;
  items: Item[];
}

function assignLanes(items: Item[], w: number, scale: number) {
  const ends: number[] = [];
  const lanes = new Int32Array(items.length);
  const minSpan = (w + GAP) * scale;
  const gap = GAP * scale;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const end = Math.max(it.t1 != null ? it.t1 + gap : -Infinity, it.t0 + minSpan);
    let lane = -1;
    for (let l = 0; l < ends.length; l++) {
      if (ends[l] <= it.t0) {
        lane = l;
        break;
      }
    }
    if (lane < 0) {
      lane = ends.length;
      ends.push(end);
    } else {
      ends[lane] = end;
    }
    lanes[i] = lane;
  }
  // 90 分位的列数：少数扎堆的日期不应让整条时间轴退化成最小卡片
  const hist = new Int32Array(ends.length + 1);
  for (let i = 0; i < lanes.length; i++) hist[lanes[i]]++;
  let acc = 0;
  let p90 = 0;
  const target = Math.ceil(items.length * 0.9);
  for (let l = 0; l < hist.length; l++) {
    acc += hist[l];
    if (acc >= target) {
      p90 = l + 1;
      break;
    }
  }
  return { lanes, count: ends.length, p90 };
}

export interface LayoutOptions {
  bucket: number;
  availCross: number;
  density: Density;
  grouped: boolean;
  types: TLType[];
  orient: Orientation;
  /** 列轴起点（留给时间刻度条的尺寸） */
  crossStart?: number;
}

export function computeLayout(items: Item[], opts: LayoutOptions): Layout {
  const scale = bucketMs(opts.bucket);
  const DIM = DIMS[opts.orient];
  let groups: Group[];
  if (opts.grouped) {
    const byType = new Map<string, Item[]>();
    for (const it of items) {
      const list = byType.get(it.n.typeId);
      if (list) list.push(it);
      else byType.set(it.n.typeId, [it]);
    }
    groups = [];
    for (const t of opts.types) {
      const list = byType.get(t.id);
      if (list?.length) groups.push({ key: t.id, label: t.name, color: t.color, icon: t.icon, items: list });
      byType.delete(t.id);
    }
    for (const [key, list] of byType) groups.push({ key, label: '未知类型', color: '#64748b', icon: '', items: list });
  } else {
    groups = [{ key: '', label: '', color: '', icon: '', items }];
  }
  const head = opts.grouped ? BAND_HEAD : 0;

  const evaluate = (lod: Lod) => {
    const per = groups.map((g) => assignLanes(g.items, DIM[lod].along, scale));
    let est = CROSS_PAD;
    per.forEach((p) => {
      est += head + Math.max(1, p.p90) * DIM[lod].lane + (opts.grouped ? BAND_GAP : 0);
    });
    return { lod, per, est };
  };

  let chosen: ReturnType<typeof evaluate> | null = null;
  if (opts.density !== 'auto') {
    chosen = evaluate(opts.density);
  } else {
    // 允许适度超出可视宽度（可以横向滚动），越紧凑的层级容忍度越高，尽量不退化成信息量很少的圆点
    const tolerance: Record<Lod, number> = { poster: 1, card: 1.12, chip: 1.7, dot: Infinity };
    for (const lod of LODS) {
      const r = evaluate(lod);
      chosen = r;
      if (r.est <= opts.availCross * tolerance[lod]) break;
    }
  }
  const { lod, per } = chosen!;
  const laneW = DIM[lod].lane;

  const bands: Band[] = [];
  const byId = new Map<string, Placed>();
  let x = (opts.crossStart ?? 0) + CROSS_PAD;
  groups.forEach((g, gi) => {
    const info = per[gi];
    const lanes = Math.max(1, info.count);
    const band: Band = { key: g.key, label: g.label, color: g.color, icon: g.icon, x, w: head + lanes * laneW, lanes, count: g.items.length };
    bands.push(band);
    g.items.forEach((it, i) => {
      const lane = info.lanes[i];
      byId.set(it.n.id, { item: it, lane, x: x + head + lane * laneW, band: gi });
    });
    x += band.w + (opts.grouped ? BAND_GAP : 0);
  });

  const placed: Placed[] = [];
  let reach = 0;
  for (const it of items) {
    const p = byId.get(it.n.id);
    if (!p) continue;
    placed.push(p);
    if (it.t1 != null) reach = Math.max(reach, it.t1 - it.t0);
  }
  return { lod, placed, byId, bands, cross: x + 24, reach };
}

/** 二分查找第一个 t0 >= t 的下标 */
export function lowerBound(placed: Placed[], t: number): number {
  let lo = 0;
  let hi = placed.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (placed[mid].item.t0 < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

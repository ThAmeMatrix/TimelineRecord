import { memo, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { camera, useCameraValue, type Cam } from '../lib/camera';
import { DAY, nowOnAxis } from '../lib/dates';
import { useDerived } from '../lib/derived';
import { bucketMs, bucketOf, computeLayout, DIMS, lowerBound, type Layout, type Placed } from '../lib/layout';
import { scopeColor } from '../lib/scope';
import { clamp } from '../lib/text';
import { computeTicks } from '../lib/ticks';
import { fitItems } from '../lib/view';
import { handleWheel } from '../lib/wheel';
import { useStore } from '../store';
import type { Orientation } from '../types';
import { MINIMAP_SIDE } from './Minimap';
import { ScrollBar } from './ScrollBar';
import { TimelineItem, type ItemState } from './TimelineItem';

/** 时间刻度条的厚度：横向时在顶部（高度），纵向时在左侧（宽度） */
export const AXIS: Record<Orientation, number> = { h: 30, v: 68 };
/** 横向时底部缩略图与工具条遮住的高度，列轴方向需要留出可滚动的余量 */
export const DOCK = 72;
const DOT = 16;
const TAU = Math.PI * 2;

const EMPTY_LAYOUT: Layout = { lod: 'dot', placed: [], byId: new Map(), bands: [], cross: 0, reach: 0 };

/** 列轴方向（不含详情面板、右侧进度条 / 底部浮层）的可视长度 */
export function crossViewLen(orient: Orientation, width: number, height: number) {
  return Math.max(120, orient === 'v' ? width - camera.insetRight - MINIMAP_SIDE : height - DOCK);
}

/**
 * 渲染窗口：把时间轴按半屏长度分块。视角在同一块内平移时，渲染的节点集合不变，
 * 组件不重渲染，只改容器的 transform；跨块时才重新挑选可见节点。
 */
function windowOf(c: Cam) {
  const b = bucketOf(c.msPerPx);
  // bucketMs(b) 是该档位 msPerPx 的上界，所以一屏的时间跨度不超过 2 块
  const chunk = (bucketMs(b) * camera.viewTimeLen()) / 2;
  return { b, k: Math.floor(c.t0 / chunk), chunk };
}

function bandStyle(v: boolean, x: number, w: number, color: string): CSSProperties {
  const s: Record<string, string | number> = v ? { left: x, width: w } : { top: x, height: w };
  s['--c'] = color || '#64748b';
  return s as CSSProperties;
}

interface Entry {
  el: HTMLElement;
  d: number;
  rd: number;
  range: HTMLElement | null;
}

export function Timeline({ onOpenNode }: { onOpenNode: (id: string) => void }) {
  const d = useDerived();
  const types = useStore((s) => s.types);
  const density = useStore((s) => s.density);
  const grouped = useStore((s) => s.grouped);
  const orient = useStore((s) => s.orientation);
  const hideOthers = useStore((s) => s.hideOthers);
  const selectedId = useStore((s) => s.selectedId);
  const focus = useStore((s) => s.focus);
  const scope = useStore((s) => s.scope);

  // 只订阅量化后的视角：平移、缩放的每一帧都不会让这个组件重渲染
  const width = useCameraValue((c) => c.width);
  const height = useCameraValue((c) => c.height);
  const bucket = useCameraValue((c) => bucketOf(c.msPerPx));

  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const bandsRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    camera.setOrient(orient);
  }, [orient]);

  const highlight = d.highlight;
  const source = useMemo(
    () => (hideOthers && highlight ? d.items.filter((it) => highlight.has(it.n.id)) : d.items),
    [d.items, hideOthers, highlight],
  );

  const originMs = useMemo(() => {
    if (!source.length) return nowOnAxis();
    let min = Infinity;
    let max = -Infinity;
    for (const it of source) {
      min = Math.min(min, it.t0);
      max = Math.max(max, it.t1 ?? it.t0);
    }
    return (min + max) / 2;
  }, [source]);

  const axis = AXIS[orient];
  const crossLen = crossViewLen(orient, width, height);
  const layout = useMemo(
    () =>
      source.length
        ? computeLayout(source, { bucket, availCross: crossLen - axis, density, grouped, types, orient, crossStart: axis })
        : EMPTY_LAYOUT,
    [source, bucket, crossLen, axis, density, grouped, types, orient],
  );
  const lod = layout.lod;

  useLayoutEffect(() => {
    camera.setMaxScroll(Math.max(0, layout.cross - crossLen));
  }, [layout.cross, crossLen]);

  // 首次拿到数据时铺满（若恢复了上次的视角则保持）
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || !d.items.length) return;
    didInit.current = true;
    if (!camera.restored) fitItems(d.items, false);
  }, [d.items]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => camera.set({ width: el.clientWidth, height: el.clientHeight }, true));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 当前渲染窗口内的节点（圆点层级完全用 canvas 绘制，不生成 DOM）
  const visible = useMemo(() => {
    if (lod === 'dot' || !layout.placed.length) return [] as Placed[];
    const w = windowOf(camera.get());
    const tLo = (w.k - 1) * w.chunk;
    const tHi = (w.k + 4) * w.chunk;
    const placed = layout.placed;
    const lo = lowerBound(placed, tLo - layout.reach);
    const hi = lowerBound(placed, tHi);
    const out: Placed[] = [];
    for (let i = lo; i < hi; i++) {
      const p = placed[i];
      if (p.item.t0 >= tLo || (p.item.t1 != null && p.item.t1 >= tLo)) out.push(p);
    }
    return out;
  }, [layout, lod]);

  const elements = useMemo(
    () =>
      visible.map((p) => {
        const n = p.item.n;
        const type = d.typeById.get(n.typeId);
        const state: ItemState =
          n.id === selectedId ? 'current' : highlight ? (highlight.has(n.id) ? 'lit' : 'dim') : 'normal';
        return (
          <TimelineItem
            key={n.id}
            node={n}
            lod={lod}
            d={(p.item.t0 - originMs) / DAY}
            x={p.x}
            rd={p.item.t1 != null ? (p.item.t1 - p.item.t0) / DAY : 0}
            color={type?.color || '#64748b'}
            icon={type?.icon || ''}
            typeName={type?.name || ''}
            regionName={n.regionId ? (d.regionById.get(n.regionId)?.name ?? '') : ''}
            state={state}
          />
        );
      }),
    [visible, lod, originMs, selectedId, highlight, d.typeById, d.regionById],
  );

  // ---------------- 每帧的命令式更新（不经过 React） ----------------

  const live = useRef({ orient, originMs, layout, lod, highlight, selectedId, axis, crossLen, typeById: d.typeById });
  live.current = { orient, originMs, layout, lod, highlight, selectedId, axis, crossLen, typeById: d.typeById };
  const entries = useRef<Entry[]>([]);
  const lastPpd = useRef(0);
  const dpr = useRef(1);
  const dotsDrawn = useRef(false);

  const drawDots = (c: Cam) => {
    const cv = canvasRef.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const L = live.current;
    ctx.setTransform(dpr.current, 0, 0, dpr.current, 0, 0);
    if (L.lod !== 'dot') {
      if (dotsDrawn.current) ctx.clearRect(0, 0, c.width, c.height);
      dotsDrawn.current = false;
      return;
    }
    dotsDrawn.current = true;
    ctx.clearRect(0, 0, c.width, c.height);
    const v = L.orient === 'v';
    const len = v ? c.height : c.width;
    const crossMax = v ? c.width : c.height;
    const placed = L.layout.placed;
    const lo = lowerBound(placed, camera.timeAt(-DOT) - L.layout.reach);
    const hi = lowerBound(placed, camera.timeAt(len + DOT));
    const r = DOT / 2;
    for (let i = lo; i < hi; i++) {
      const p = placed[i];
      const cp = p.x - c.scroll;
      if (cp < L.axis - DOT || cp > crossMax) continue;
      const tp = camera.posOf(p.item.t0);
      const te = p.item.t1 != null ? camera.posOf(p.item.t1) : tp;
      if (Math.max(tp, te) < -DOT) continue;
      const alpha = L.highlight ? (L.highlight.has(p.item.n.id) ? 1 : 0.16) : 0.95;
      ctx.fillStyle = L.typeById.get(p.item.n.typeId)?.color || '#64748b';
      if (te - tp > DOT) {
        ctx.globalAlpha = alpha * 0.45;
        if (v) ctx.fillRect(cp + r - 1.5, tp + r, 3, te - tp - r);
        else ctx.fillRect(tp + r, cp + r - 1.5, te - tp - r, 3);
      }
      ctx.globalAlpha = alpha;
      const x = v ? cp + r : tp + r;
      const y = v ? tp + r : cp + r;
      ctx.beginPath();
      ctx.arc(x, y, r - 1.5, 0, TAU);
      ctx.fill();
      if (p.item.n.id === L.selectedId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r + 1.5, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  };

  const applyRef = useRef<(force: boolean) => void>(() => {});
  applyRef.current = (force) => {
    const c = camera.get();
    const L = live.current;
    const v = L.orient === 'v';
    const off = (L.originMs - c.t0) / c.msPerPx;
    const items = itemsRef.current;
    if (items) items.style.transform = v ? `translate3d(${-c.scroll}px,${off}px,0)` : `translate3d(${off}px,${-c.scroll}px,0)`;
    const bands = bandsRef.current;
    if (bands) bands.style.transform = v ? `translate3d(${-c.scroll}px,0,0)` : `translate3d(0,${-c.scroll}px,0)`;
    const ppd = DAY / c.msPerPx;
    if (force || ppd !== lastPpd.current) {
      lastPpd.current = ppd;
      for (const e of entries.current) {
        const p = e.d * ppd;
        e.el.style.transform = v ? `translate3d(0,${p}px,0)` : `translate3d(${p}px,0,0)`;
        if (e.range) {
          const size = `${Math.max(2, e.rd * ppd)}px`;
          e.range.style.height = v ? size : '';
          e.range.style.width = v ? '' : size;
        }
      }
    }
    drawDots(c);
  };

  useLayoutEffect(() => camera.subscribe(() => applyRef.current(false)), []);

  // 每次提交新的节点集合后，收集元素并立即放到正确位置（在绘制之前）
  useLayoutEffect(() => {
    const box = itemsRef.current;
    const list: Entry[] = [];
    if (box) {
      for (const child of Array.from(box.children)) {
        const el = child as HTMLElement;
        const rd = Number(el.dataset.rd) || 0;
        list.push({ el, d: Number(el.dataset.d) || 0, rd, range: rd > 0 ? el.querySelector<HTMLElement>('.tl-range') : null });
      }
    }
    entries.current = list;
    applyRef.current(true);
  }, [elements, orient, lod, highlight, selectedId, grouped]);

  useLayoutEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    dpr.current = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(width * dpr.current);
    cv.height = Math.round(height * dpr.current);
    cv.style.width = `${width}px`;
    cv.style.height = `${height}px`;
    dotsDrawn.current = true;
    applyRef.current(true);
  }, [width, height]);

  // ---------------- 聚焦 ----------------

  useEffect(() => {
    if (!focus) return;
    const L = live.current;
    const p = L.layout.byId.get(focus.id);
    if (!p) return;
    const c = camera.get();
    const len = camera.viewTimeLen();
    const dim = DIMS[L.orient][L.lod];
    const tp = camera.posOf(p.item.t0);
    const cp = p.x - c.scroll;
    const inView = tp >= 20 && tp + dim.along <= len - 20 && cp >= L.axis && cp + dim.across <= L.crossLen;
    if (focus.mode === 'reveal' && inView && !focus.zoom) return;
    const ms = focus.zoom ? Math.min(c.msPerPx, 9 * DAY) : c.msPerPx;
    const scroll = clamp(p.x + dim.across / 2 - (L.axis + L.crossLen) / 2, 0, camera.maxScroll);
    camera.flyTo(p.item.t0 + (dim.along / 2) * ms, ms, { scroll });
  }, [focus]);

  // ---------------- 交互 ----------------

  const onOpenRef = useRef(onOpenNode);
  onOpenRef.current = onOpenNode;

  /** 圆点层级的点击命中测试（tp/cp：时间轴/列轴上的屏幕坐标） */
  const hitDot = (tp: number, cp: number): string | null => {
    const L = live.current;
    if (L.lod !== 'dot') return null;
    const c = camera.get();
    const placed = L.layout.placed;
    const lo = lowerBound(placed, camera.timeAt(tp - DOT - 3));
    const hi = lowerBound(placed, camera.timeAt(tp + 3));
    let best: string | null = null;
    let bestD = (DOT / 2 + 3) ** 2;
    for (let i = lo; i < hi; i++) {
      const p = placed[i];
      const a = camera.posOf(p.item.t0) + DOT / 2 - tp;
      const b = p.x - c.scroll + DOT / 2 - cp;
      const dd = a * a + b * b;
      if (dd <= bestD) {
        bestD = dd;
        best = p.item.n.id;
      }
    }
    return best;
  };

  const drag = useRef<{
    x: number;
    y: number;
    t0: number;
    scroll: number;
    moved: boolean;
    id: string | null;
    last: number;
    lt: number;
    vel: number;
  } | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // React 的 onWheel 是被动监听，无法阻止浏览器缩放页面，所以用原生监听
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      handleWheel(e, live.current.orient === 'v' ? e.clientY - rect.top : e.clientX - rect.left);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const endDrag = () => {
    drag.current = null;
    rootRef.current?.classList.remove('dragging');
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    camera.stop();
    const id = (e.target as HTMLElement).closest<HTMLElement>('.tl-item')?.dataset.id ?? null;
    const c = camera.get();
    const v = orient === 'v';
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      t0: c.t0,
      scroll: c.scroll,
      moved: false,
      id,
      last: v ? e.clientY : e.clientX,
      lt: performance.now(),
      vel: 0,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const v = orient === 'v';
    const dr = drag.current;
    if (!dr) {
      const hover = hoverRef.current;
      if (hover) {
        const rect = e.currentTarget.getBoundingClientRect();
        const p = v ? e.clientY - rect.top : e.clientX - rect.left;
        hover.style.transform = v ? `translate3d(0,${p}px,0)` : `translate3d(${p}px,0,0)`;
      }
      return;
    }
    const dx = e.clientX - dr.x;
    const dy = e.clientY - dr.y;
    if (!dr.moved) {
      if (dx * dx + dy * dy < 16) return;
      dr.moved = true;
      rootRef.current?.classList.add('dragging');
    }
    const dTime = v ? dy : dx;
    const dCross = v ? dx : dy;
    camera.set({ t0: dr.t0 - dTime * camera.get().msPerPx, scroll: dr.scroll - dCross });
    const now = performance.now();
    const pos = v ? e.clientY : e.clientX;
    const dt = now - dr.lt;
    if (dt > 0) dr.vel = 0.8 * ((pos - dr.last) / dt) + 0.2 * dr.vel;
    dr.last = pos;
    dr.lt = now;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const dr = drag.current;
    endDrag();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!dr) return;
    if (!dr.moved) {
      let id = dr.id;
      if (!id) {
        const rect = e.currentTarget.getBoundingClientRect();
        const v = orient === 'v';
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        id = hitDot(v ? y : x, v ? x : y);
      }
      if (id) onOpenRef.current(id);
      else useStore.getState().selectNode(null);
    } else if (performance.now() - dr.lt < 80 && Math.abs(dr.vel) > 0.05) {
      camera.inertia(dr.vel);
    }
  };

  const v = orient === 'v';
  const rootStyle = highlight ? ({ '--spot': scopeColor(scope, d.typeById) } as CSSProperties) : undefined;

  return (
    <div
      ref={rootRef}
      className={`tl tl-${orient}${grouped ? ' grouped' : ''}${highlight ? ' has-highlight' : ''}`}
      style={rootStyle}
    >
      <div
        className="tl-body"
        ref={bodyRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={endDrag}
        onPointerEnter={() => hoverRef.current?.classList.add('on')}
        onPointerLeave={() => hoverRef.current?.classList.remove('on')}
      >
        <Axis orient={orient} />

        {grouped && (
          <div className="tl-bands" ref={bandsRef}>
            {layout.bands.map((b) => (
              <div
                key={b.key}
                className="tl-band"
                style={bandStyle(v, b.x, b.w, b.color)}
              >
                <div className="tl-band-head">
                  <span>{b.icon}</span>
                  <b>{b.label}</b>
                  <em>{b.count}</em>
                </div>
              </div>
            ))}
          </div>
        )}

        <canvas className="tl-dots" ref={canvasRef} />

        <div className="tl-items" ref={itemsRef}>
          {elements}
        </div>

        <div className="tl-hover" ref={hoverRef} />

        {!d.items.length && <div className="tl-empty">还没有时间节点。点右上角“添加”，或导入一份数据。</div>}

        <ScrollBar orient={orient} start={axis} visible={crossLen - axis} />
      </div>
    </div>
  );
}

/** 时间刻度与网格线：只在“可见刻度集合”变化时才重渲染（平移量化到约一屏一档），位置用 transform 走合成层 */
const Axis = memo(function Axis({ orient }: { orient: Orientation }) {
  // 量化后的版本号：平移时每跨过 BUCKET 像素才变一次，避免每帧重渲染几十个节点
  const version = useCameraValue((c) => {
    const step = Math.max(40, Math.round(280 / c.msPerPx));
    return `${orient}|${c.msPerPx.toFixed(4)}|${Math.floor(c.t0 / step)}|${Math.round(c.orient === 'v' ? c.height : c.width)}`;
  });
  const cam = camera.get();
  const v = orient === 'v';
  const len = v ? cam.height : cam.width;
  const ticks = useMemo(
    () => computeTicks(cam.t0, cam.t0 + len * cam.msPerPx, cam.msPerPx, v ? 40 : 70),
    // 只用 version 触发重算，避免每像素重渲染
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  const pos = (t: number) => ((t - cam.t0) / cam.msPerPx) as number;
  const tf = (p: number) => (v ? `translate3d(0,${p}px,0)` : `translate3d(${p}px,0,0)`);
  const majorSet = new Set(ticks.major.map((t) => t.t));
  const minor = ticks.minor.filter((t) => !majorSet.has(t.t));
  const today = pos(nowOnAxis());
  const showToday = today > -4 && today < len + 4;

  return (
    <>
      <div className="tl-grid-wrap">
        {minor.map((t) => (
          <div key={`n${t.t}`} className="tl-grid" style={{ transform: tf(pos(t.t)) }} />
        ))}
        {ticks.major.map((t) => (
          <div key={`j${t.t}`} className="tl-grid major" style={{ transform: tf(pos(t.t)) }} />
        ))}
        {showToday && <div className="tl-today" style={{ transform: tf(today) }} />}
      </div>
      <div className="tl-axis">
        {minor.map((t) => (
          <div key={`n${t.t}`} className="ax-row" style={{ transform: tf(pos(t.t)) }}>
            <span className="ax-label">{t.label}</span>
          </div>
        ))}
        {ticks.major.map((t) => (
          <div key={`j${t.t}`} className="ax-row major" style={{ transform: tf(pos(t.t)) }}>
            <span className="ax-label">{t.label}</span>
          </div>
        ))}
        {showToday && (
          <div className="ax-today" style={{ transform: tf(today) }}>
            <span>今天</span>
          </div>
        )}
      </div>
    </>
  );
});

import { useEffect, useMemo, useRef, useState } from 'react';
import { camera, useCamera } from '../lib/camera';
import { DAY, nowOnAxis } from '../lib/dates';
import { useDerived } from '../lib/derived';
import { clamp } from '../lib/text';
import { handleWheel } from '../lib/wheel';
import type { Orientation } from '../types';

/** 进度条的厚度：横向时是高度，纵向时是宽度 */
export const MINIMAP_THICK: Record<Orientation, number> = { h: 46, v: 58 };
/** 纵向时进度条贴在右侧，时间轴列方向需要让出的宽度（厚度 + 两侧边距） */
export const MINIMAP_SIDE = MINIMAP_THICK.v + 16;
/** 纵向时左侧留给年份文字的宽度 */
const LABEL_V = 28;

/**
 * 时间进度条（全局缩略图）。横向时间轴时横放在底部，纵向时竖放在右侧，
 * 方向与时间轴一致：拖动或点击跳转，滚轮滚动，Ctrl + 滚轮缩放。
 */
export function Minimap({ orient }: { orient: Orientation }) {
  const cam = useCamera();
  const d = useDerived();
  const v = orient === 'v';
  const T = MINIMAP_THICK[orient];
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 沿时间方向的长度 */
  const [len, setLen] = useState(800);
  const drag = useRef<{ offset: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLen(Math.max(100, Math.round(v ? el.clientHeight : el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [v]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.stopPropagation();
      handleWheel(e, camera.viewTimeLen() / 2);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const dataExtent = useMemo(() => {
    const now = nowOnAxis();
    let min = now;
    let max = now;
    for (const it of d.items) {
      min = Math.min(min, it.t0);
      max = Math.max(max, it.t1 ?? it.t0);
    }
    const pad = Math.max((max - min) * 0.05, 200 * DAY);
    return { min: min - pad, max: max + pad };
  }, [d.items]);

  const viewSpan = camera.viewTimeLen() * cam.msPerPx;
  const lo = Math.min(dataExtent.min, cam.t0);
  const hi = Math.max(dataExtent.max, cam.t0 + viewSpan);
  // 视角在数据范围内时范围不变，平移不会触发重绘
  const extKey = `${Math.round(lo / DAY)}|${Math.round(hi / DAY)}`;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cw = v ? T : len;
    const ch = v ? len : T;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    /** a：沿时间方向，c：沿厚度方向 */
    const rect = (a: number, c: number, la: number, lc: number) => {
      if (v) ctx.fillRect(c, a, lc, la);
      else ctx.fillRect(a, c, la, lc);
    };
    const bins = Math.max(24, Math.floor(len / 4));
    const typeOrder = [...d.typeById.keys()];
    const stacks: Map<string, number>[] = Array.from({ length: bins }, () => new Map());
    const totals = new Float32Array(bins);
    const lit = new Float32Array(bins);
    const range = hi - lo;
    for (const it of d.items) {
      const b = Math.floor(((it.t0 - lo) / range) * bins);
      if (b < 0 || b >= bins) continue;
      totals[b]++;
      stacks[b].set(it.n.typeId, (stacks[b].get(it.n.typeId) ?? 0) + 1);
      if (d.highlight?.has(it.n.id)) lit[b]++;
    }
    let max = 1;
    for (const x of totals) max = Math.max(max, x);
    const bw = len / bins;
    // 柱子从厚度方向的末端（横向：底部；纵向：右侧）向内生长，另一端留给年份文字
    const base = T - 4;
    const usable = T - (v ? LABEL_V + 4 : 14);
    for (let b = 0; b < bins; b++) {
      if (!totals[b]) continue;
      const total = Math.sqrt(totals[b] / max) * usable;
      const a = b * bw + 0.5;
      const la = Math.max(1, bw - 1);
      if (d.highlight) {
        ctx.fillStyle = 'rgba(148,163,184,0.18)';
        rect(a, base - total, la, total);
        if (lit[b]) {
          const lh = Math.max(2, (lit[b] / totals[b]) * total);
          ctx.fillStyle = '#ffd166';
          rect(a, base - lh, la, lh);
        }
        continue;
      }
      let c = base;
      ctx.globalAlpha = 0.75;
      for (const typeId of typeOrder) {
        const n = stacks[b].get(typeId);
        if (!n) continue;
        const h = (n / totals[b]) * total;
        ctx.fillStyle = d.typeById.get(typeId)?.color ?? '#64748b';
        rect(a, c - h, la, h);
        c -= h;
      }
      ctx.globalAlpha = 1;
    }
    // 年份刻度
    const startYear = new Date(lo).getUTCFullYear();
    const endYear = new Date(hi).getUTCFullYear();
    const years = endYear - startYear;
    const gap = v ? 34 : 64;
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => (years / s) * gap <= len) ?? 1000;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(203,213,225,0.55)';
    for (let y = Math.ceil(startYear / step) * step; y <= endYear; y += step) {
      const a = Math.round(((Date.UTC(y, 0, 1) - lo) / range) * len);
      rect(a, 0, 1, 5);
      if (v) ctx.fillText(String(y), 2, a + 12);
      else ctx.fillText(String(y), a + 3, 10);
    }
    const nowA = Math.round(((nowOnAxis() - lo) / range) * len);
    ctx.fillStyle = 'rgba(255,107,139,0.9)';
    rect(nowA, 0, 1, T);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.items, d.highlight, d.typeById, extKey, len, v, T]);

  const toA = (t: number) => ((t - lo) / (hi - lo)) * len;
  const toT = (a: number) => lo + (a / len) * (hi - lo);
  const start = toA(cam.t0);
  const size = Math.max(6, toA(cam.t0 + viewSpan) - start);

  const localA = (e: React.PointerEvent) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return v ? e.clientY - r.top : e.clientX - r.left;
  };

  const viewStyle = v
    ? { transform: `translate3d(0,${Math.round(start)}px,0)`, height: Math.round(size) }
    : { transform: `translate3d(${Math.round(start)}px,0,0)`, width: Math.round(size) };

  return (
    <div
      ref={wrapRef}
      className={`minimap tl-noadd ${v ? 'vert' : ''}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        camera.stop();
        const a = localA(e);
        const inside = a >= start && a <= start + size;
        const t = toT(a);
        const offset = inside ? t - cam.t0 : viewSpan / 2;
        if (!inside) camera.set({ t0: t - offset });
        drag.current = { offset };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        camera.set({ t0: toT(clamp(localA(e), 0, len)) - drag.current.offset });
      }}
      onPointerUp={(e) => {
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      title="拖动或点击跳转；滚轮滚动，Ctrl + 滚轮缩放"
    >
      <canvas ref={canvasRef} style={v ? { width: T, height: len } : { width: len, height: T }} />
      <div className="minimap-view" style={viewStyle} />
    </div>
  );
}

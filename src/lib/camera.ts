import { useSyncExternalStore } from 'react';
import type { Orientation } from '../types';
import { DAY, YEAR, utc } from './dates';
import { clamp } from './text';

export interface Cam {
  /** 视口在时间轴起点处（横向为左边缘，纵向为上边缘）对应的时间（UTC 毫秒） */
  t0: number;
  /** 每像素代表的毫秒数（沿时间轴） */
  msPerPx: number;
  width: number;
  height: number;
  /** 沿列轴（与时间轴垂直的方向）的滚动距离 */
  scroll: number;
  /** h = 时间沿水平方向；v = 时间沿垂直方向 */
  orient: Orientation;
}

export const MIN_MS_PER_PX = DAY / 480;
export const MAX_MS_PER_PX = (YEAR * 500) / 1000;
const MIN_T = utc(1000, 1, 1);
const MAX_T = utc(2999, 12, 31);
const LOG_MIN = Math.log(MIN_MS_PER_PX);
const LOG_MAX = Math.log(MAX_MS_PER_PX);
const STORAGE_KEY = 'tl-camera';

type Listener = () => void;

/** 一维的 van Wijk & Nuij 平滑缩放平移插值（与 d3.interpolateZoom 同源） */
function interpolateZoom(c0: number, w0: number, c1: number, w1: number) {
  const rho = Math.SQRT2;
  const rho2 = 2;
  const rho4 = 4;
  const dx = c1 - c0;
  const d1 = Math.abs(dx);
  if (d1 < 1e-6 * Math.max(w0, w1)) {
    const S = Math.log(w1 / w0) / rho;
    return {
      duration: Math.abs(S) * 1000,
      at: (t: number): [number, number] => [c0 + t * dx, w0 * Math.exp(rho * t * S)],
    };
  }
  const b0 = (w1 * w1 - w0 * w0 + rho4 * dx * dx) / (2 * w0 * rho2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - rho4 * dx * dx) / (2 * w1 * rho2 * d1);
  const r0 = -Math.asinh(b0);
  const r1 = -Math.asinh(b1);
  const S = (r1 - r0) / rho;
  const coshr0 = Math.cosh(r0);
  const sinhr0 = Math.sinh(r0);
  return {
    duration: Math.abs(S) * 1000,
    at: (t: number): [number, number] => {
      const s = t * S;
      const u = (w0 / (rho2 * d1)) * (coshr0 * Math.tanh(rho * s + r0) - sinhr0);
      return [c0 + u * dx, (w0 * coshr0) / Math.cosh(rho * s + r0)];
    },
  };
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

class Camera {
  private s: Cam;
  private listeners = new Set<Listener>();
  private emitRaf = 0;
  private flyRaf = 0;
  private zoomRaf = 0;
  private inertiaRaf = 0;
  private panRaf = 0;
  private zoomTarget: { log: number; p: number; last: number } | null = null;
  private panTarget: { t0: number; last: number } | null = null;
  private saveTimer = 0;
  /** 由时间轴根据布局设置（列轴方向可滚动的最大距离） */
  maxScroll = 0;
  /** 右侧详情面板占据的宽度（居中时要避开） */
  insetRight = 0;
  /** 是否从上次的会话恢复了视角（恢复了就不再自动铺满） */
  restored = false;

  constructor() {
    const span = 12 * YEAR;
    let t0 = Date.now() - span * 0.7;
    let msPerPx = span / 1400;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && Number.isFinite(saved.t0) && Number.isFinite(saved.msPerPx)) {
        t0 = saved.t0;
        msPerPx = saved.msPerPx;
        this.restored = true;
      }
    } catch {
      /* ignore */
    }
    this.s = {
      t0,
      msPerPx: clamp(msPerPx, MIN_MS_PER_PX, MAX_MS_PER_PX),
      width: 1400,
      height: 800,
      scroll: 0,
      orient: 'v',
    };
  }

  get = (): Cam => this.s;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private emit() {
    for (const l of this.listeners) l();
    if (!this.saveTimer) {
      this.saveTimer = window.setTimeout(() => {
        this.saveTimer = 0;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ t0: this.s.t0, msPerPx: this.s.msPerPx }));
        } catch {
          /* ignore */
        }
      }, 600);
    }
  }

  private timeLenOf(c: Cam) {
    return Math.max(200, c.orient === 'v' ? c.height : c.width - this.insetRight);
  }

  private clampState(c: Cam): Cam {
    const msPerPx = clamp(c.msPerPx, MIN_MS_PER_PX, MAX_MS_PER_PX);
    const span = this.timeLenOf(c) * msPerPx;
    const t0 = clamp(c.t0, MIN_T - span * 0.5, MAX_T - span * 0.5);
    const scroll = clamp(c.scroll, 0, Math.max(0, this.maxScroll));
    return { ...c, msPerPx, t0, scroll };
  }

  /** 更新视角；immediate=true 时同步通知（动画帧内使用），否则合并到下一帧 */
  set(p: Partial<Cam>, immediate = false) {
    this.s = this.clampState({ ...this.s, ...p });
    if (immediate) {
      if (this.emitRaf) {
        cancelAnimationFrame(this.emitRaf);
        this.emitRaf = 0;
      }
      this.emit();
    } else if (!this.emitRaf) {
      this.emitRaf = requestAnimationFrame(() => {
        this.emitRaf = 0;
        this.emit();
      });
    }
  }

  /** 切换方向：保持视野中心时间与缩放不变，列轴滚动归零 */
  setOrient(orient: Orientation) {
    if (orient === this.s.orient) return;
    this.stop();
    const center = this.centerTime();
    const next = { ...this.s, orient, scroll: 0 };
    next.t0 = center - (this.timeLenOf(next) / 2) * next.msPerPx;
    this.set(next, true);
  }

  setMaxScroll(max: number) {
    this.maxScroll = Math.max(0, max);
    if (this.s.scroll > this.maxScroll) this.set({ scroll: this.maxScroll });
  }

  /** 时间轴方向上的可见长度（像素） */
  viewTimeLen() {
    return this.timeLenOf(this.s);
  }

  /** 列轴方向上的可见长度（像素，纵向时已扣除右侧详情面板） */
  viewCrossLen() {
    return Math.max(120, this.s.orient === 'v' ? this.s.width - this.insetRight : this.s.height);
  }

  /** 时间轴上的屏幕坐标 → 时间 */
  timeAt(p: number) {
    return this.s.t0 + p * this.s.msPerPx;
  }

  /** 时间 → 时间轴上的屏幕坐标 */
  posOf(t: number) {
    return (t - this.s.t0) / this.s.msPerPx;
  }

  centerTime() {
    return this.s.t0 + (this.viewTimeLen() / 2) * this.s.msPerPx;
  }

  isAnimating() {
    return !!(this.flyRaf || this.zoomRaf || this.inertiaRaf || this.panRaf);
  }

  stop() {
    if (this.flyRaf) cancelAnimationFrame(this.flyRaf);
    if (this.zoomRaf) cancelAnimationFrame(this.zoomRaf);
    if (this.inertiaRaf) cancelAnimationFrame(this.inertiaRaf);
    if (this.panRaf) cancelAnimationFrame(this.panRaf);
    this.flyRaf = this.zoomRaf = this.inertiaRaf = this.panRaf = 0;
    this.zoomTarget = null;
    this.panTarget = null;
  }

  private cancelPan() {
    if (this.panRaf) cancelAnimationFrame(this.panRaf);
    this.panRaf = 0;
    this.panTarget = null;
  }

  /** 平滑滚轮滚动：沿时间轴前进 px 像素（负数为后退），连续滚动会累积目标 */
  wheelPan(px: number) {
    if (this.flyRaf) cancelAnimationFrame(this.flyRaf);
    if (this.inertiaRaf) cancelAnimationFrame(this.inertiaRaf);
    if (this.zoomRaf) cancelAnimationFrame(this.zoomRaf);
    this.flyRaf = this.inertiaRaf = this.zoomRaf = 0;
    this.zoomTarget = null;
    const base = this.panTarget ? this.panTarget.t0 : this.s.t0;
    this.panTarget = { t0: base + px * this.s.msPerPx, last: performance.now() };
    if (!this.panRaf) this.panRaf = requestAnimationFrame(this.panStep);
  }

  private panStep = (now: number) => {
    this.panRaf = 0;
    const pt = this.panTarget;
    if (!pt) return;
    const dt = Math.min(64, Math.max(1, now - pt.last));
    pt.last = now;
    const diff = pt.t0 - this.s.t0;
    const done = Math.abs(diff) < this.s.msPerPx * 0.5;
    const want = done ? pt.t0 : this.s.t0 + diff * (1 - Math.pow(1 - 0.25, dt / 16.67));
    this.set({ t0: want }, true);
    // 到达目标，或被时间范围边界截住时结束
    if (done || Math.abs(this.s.t0 - want) > this.s.msPerPx) {
      this.panTarget = null;
      return;
    }
    this.panRaf = requestAnimationFrame(this.panStep);
  };

  /** 沿时间轴与列轴同时平移（像素） */
  panBy(dTimePx: number, dCrossPx = 0) {
    this.set({ t0: this.s.t0 - dTimePx * this.s.msPerPx, scroll: this.s.scroll - dCrossPx });
  }

  /** 平滑滚轮缩放：不断累积目标缩放，按时间指数逼近；p 为时间轴上的锚点坐标 */
  wheelZoom(deltaLog: number, p: number) {
    if (this.flyRaf) cancelAnimationFrame(this.flyRaf);
    if (this.inertiaRaf) cancelAnimationFrame(this.inertiaRaf);
    this.flyRaf = this.inertiaRaf = 0;
    this.cancelPan();
    const base = this.zoomTarget ? this.zoomTarget.log : Math.log(this.s.msPerPx);
    this.zoomTarget = { log: clamp(base + deltaLog, LOG_MIN, LOG_MAX), p, last: performance.now() };
    if (!this.zoomRaf) this.zoomRaf = requestAnimationFrame(this.zoomStep);
  }

  private zoomStep = (now: number) => {
    this.zoomRaf = 0;
    const zt = this.zoomTarget;
    if (!zt) return;
    const dt = Math.min(64, Math.max(1, now - zt.last));
    zt.last = now;
    const cur = Math.log(this.s.msPerPx);
    const diff = zt.log - cur;
    const k = 1 - Math.pow(1 - 0.3, dt / 16.67);
    const next = Math.abs(diff) < 0.003 ? zt.log : cur + diff * k;
    const t = this.timeAt(zt.p);
    const msPerPx = Math.exp(next);
    this.set({ msPerPx, t0: t - zt.p * msPerPx }, true);
    if (next === zt.log) {
      this.zoomTarget = null;
      return;
    }
    this.zoomRaf = requestAnimationFrame(this.zoomStep);
  };

  /** 拖拽松手后的惯性滑动，v 单位为 px/ms（沿时间轴） */
  inertia(v: number) {
    this.stop();
    let vel = v;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      this.set({ t0: this.s.t0 - vel * dt * this.s.msPerPx }, true);
      vel *= Math.pow(0.9955, dt);
      if (Math.abs(vel) < 0.015) {
        this.inertiaRaf = 0;
        return;
      }
      this.inertiaRaf = requestAnimationFrame(step);
    };
    this.inertiaRaf = requestAnimationFrame(step);
  }

  /** 平滑飞行到指定中心时间与缩放（远距离会先拉远再推近） */
  flyTo(center: number, msPerPx: number, opts: { scroll?: number; duration?: number } = {}) {
    this.stop();
    const L = this.viewTimeLen();
    const target = clamp(msPerPx, MIN_MS_PER_PX, MAX_MS_PER_PX);
    const c0 = this.s.t0 + (L / 2) * this.s.msPerPx;
    const w0 = L * this.s.msPerPx;
    const w1 = L * target;
    const path = interpolateZoom(c0, w0, center, w1);
    const duration = opts.duration ?? clamp(path.duration * 0.85, 340, 1200);
    const s0 = this.s.scroll;
    const s1 = opts.scroll ?? s0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = easeInOutCubic(t);
      const [c, w] = t >= 1 ? [center, w1] : path.at(e);
      const m = w / L;
      this.set({ msPerPx: m, t0: c - (L / 2) * m, scroll: s0 + (s1 - s0) * e }, true);
      this.flyRaf = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.flyRaf = requestAnimationFrame(step);
  }
}

export const camera = new Camera();

/** 订阅完整视角（每帧都会更新，只用于很轻的组件） */
export function useCamera(): Cam {
  return useSyncExternalStore(camera.subscribe, camera.get);
}

/** 只订阅视角的某个派生值（应返回原始值）；值不变时组件不会重渲染 */
export function useCameraValue<T extends string | number | boolean>(select: (c: Cam) => T): T {
  return useSyncExternalStore(camera.subscribe, () => select(camera.get()));
}

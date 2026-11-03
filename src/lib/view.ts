import type { Item } from './layout';
import { camera } from './camera';
import { DAY, YEAR, dateEnd, dateStart, nowOnAxis } from './dates';
import { useStore } from '../store';

/** 导入数据后：按 store 中的全部节点铺满视角 */
export function fitAllNodes() {
  const items: Item[] = Object.values(useStore.getState().nodes).map((n) => ({
    n,
    t0: dateStart(n.start),
    t1: n.end ? dateEnd(n.end) : null,
  }));
  fitItems(items, true);
}

/** 视角铺满给定节点（时间轴方向上下留少量边距） */
export function fitItems(items: Item[], animate = true) {
  const H = camera.viewTimeLen();
  if (!items.length) {
    camera.flyTo(nowOnAxis(), (10 * YEAR) / H);
    return;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const it of items) {
    min = Math.min(min, it.t0);
    max = Math.max(max, it.t1 ?? it.t0 + DAY);
  }
  const usable = Math.max(240, H - 120);
  const msPerPx = Math.max(max - min, 60 * DAY) / usable;
  const t0 = min - 60 * msPerPx;
  const center = t0 + (H / 2) * msPerPx;
  if (animate) camera.flyTo(center, msPerPx, { scroll: 0 });
  else camera.set({ msPerPx, t0, scroll: 0 }, true);
}

export function goToday() {
  const c = camera.get();
  const H = camera.viewTimeLen();
  const span = c.msPerPx * H;
  const msPerPx = span > 40 * YEAR || span < 45 * DAY ? (3 * YEAR) / H : c.msPerPx;
  camera.flyTo(nowOnAxis(), msPerPx);
}

export function zoomBy(factor: number) {
  camera.wheelZoom(Math.log(factor), camera.viewTimeLen() / 2);
}

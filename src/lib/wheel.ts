import { camera } from './camera';

/**
 * 时间轴与进度条共用的滚轮行为：
 * - 滚轮：沿时间轴平滑滚动（进度条上的视野框随之移动）
 * - Ctrl / ⌘ + 滚轮（含触控板捏合）：以 anchor（时间轴上的屏幕坐标）为中心缩放
 * - Shift + 滚轮：沿列（泳道）方向滚动
 * 需要用 { passive: false } 的原生监听调用，才能阻止浏览器自身的页面缩放 / 滚动。
 */
export function handleWheel(e: WheelEvent, anchor: number) {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? camera.viewTimeLen() : 1;
  if (e.ctrlKey || e.metaKey) {
    camera.wheelZoom(e.deltaY * (e.deltaMode === 1 ? 0.04 : 0.0022), anchor);
    return;
  }
  if (e.shiftKey) {
    camera.panBy(0, -(e.deltaY || e.deltaX) * unit);
    return;
  }
  if (camera.get().orient === 'v') {
    // 纵向：上下滚动 = 时间；触控板左右滑 = 泳道
    if (e.deltaY) camera.wheelPan(e.deltaY * unit);
    if (e.deltaX) camera.panBy(0, -e.deltaX * unit);
  } else {
    // 横向：鼠标滚轮与触控板左右滑都沿时间滚动
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (d) camera.wheelPan(d * unit);
  }
}

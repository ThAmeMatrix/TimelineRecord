import { useRef } from 'react';
import { camera, useCameraValue } from '../lib/camera';
import { clamp } from '../lib/text';
import type { Orientation } from '../types';

/**
 * 列轴滚动条（控制 camera.scroll）。
 * 纵向时间轴：列轴是水平方向，滚动条横放在顶部；横向时间轴：列轴是垂直方向，滚动条竖放在右侧。
 */
export function ScrollBar({ orient, start, visible }: { orient: Orientation; start: number; visible: number }) {
  const scroll = useCameraValue((c) => c.scroll);
  const max = useCameraValue(() => camera.maxScroll);
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ grab: number } | null>(null);
  const v = orient === 'v';

  if (max <= 0) return null;
  const frac = clamp(visible / (max + visible), 0.06, 1);
  const thumbStart = (scroll / max) * (1 - frac);

  const rectOf = () => {
    const r = trackRef.current!.getBoundingClientRect();
    return v ? { s: r.left, len: r.width } : { s: r.top, len: r.height };
  };
  const posOf = (e: React.PointerEvent) => (v ? e.clientX : e.clientY);
  const setScroll = (client: number, grab: number) => {
    const { s, len } = rectOf();
    const free = len * (1 - frac);
    if (free <= 0) return;
    camera.set({ scroll: clamp((client - s - grab) / free, 0, 1) * max });
  };

  const style = v ? { left: start, width: visible - 8 } : { top: start, height: visible - 8 };
  const thumb = v
    ? { left: `${thumbStart * 100}%`, width: `${frac * 100}%` }
    : { top: `${thumbStart * 100}%`, height: `${frac * 100}%` };

  return (
    <div
      className="tl-scrollbar"
      ref={trackRef}
      style={style}
      onPointerDown={(e) => {
        e.stopPropagation();
        camera.stop();
        const { s, len } = rectOf();
        const thumbLen = frac * len;
        const grab = posOf(e) - s - thumbStart * len;
        const inside = grab >= -1 && grab <= thumbLen + 1;
        drag.current = { grab: inside ? grab : thumbLen / 2 };
        e.currentTarget.setPointerCapture(e.pointerId);
        if (!inside) setScroll(posOf(e), drag.current.grab);
      }}
      onPointerMove={(e) => {
        if (drag.current) setScroll(posOf(e), drag.current.grab);
      }}
      onPointerUp={(e) => {
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    >
      <div className="tl-scrollbar-thumb" style={thumb} />
    </div>
  );
}

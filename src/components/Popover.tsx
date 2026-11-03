import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  trigger: (props: { open: boolean; toggle: () => void; ref: (el: HTMLElement | null) => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  width?: number;
  minWidth?: number;
  /** 内容比触发器宽时也能完整显示：按内容自适应宽度并夹在视口内 */
  maxWidth?: number;
}

/** 用 portal 渲染的浮层：脱离任何 overflow/transform 容器，不会被遮挡 */
export function Popover({ trigger, children, align = 'right', width, minWidth, maxWidth = 360 }: Props) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const close = () => setOpen(false);
  const toggle = () => setOpen((o) => !o);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const place = (pw: number) => {
      const w = Math.min(pw, maxWidth);
      let left = align === 'right' ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      setPos({ left, top: r.bottom + 6 });
    };
    const est = width ?? Math.max(minWidth ?? 0, r.width);
    place(est);
    if (!width) {
      requestAnimationFrame(() => {
        const pw = popRef.current?.offsetWidth ?? est;
        place(pw);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, align, width, minWidth, maxWidth]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node) || anchorRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return (
    <>
      {trigger({ open, toggle, ref: (el) => (anchorRef.current = el) })}
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="popover menu"
            style={{ position: 'fixed', left: pos.left, top: pos.top, width: width ?? 'auto', minWidth, maxWidth, zIndex: 1000 }}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}

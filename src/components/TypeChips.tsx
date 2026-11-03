import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useDerived } from '../lib/derived';
import { NO_REGION } from '../lib/scope';
import { readableOn } from '../lib/text';
import { useStore } from '../store';
import type { Scope } from '../types';

type Sel = Record<string, string[] | null>;

function applySel(sel: Sel) {
  const scope: Scope = Object.keys(sel).length ? { kind: 'filter', sel, origin: 'bar' } : { kind: 'none' };
  useStore.getState().setScope(scope);
}

export function TypeChips() {
  const types = useStore((s) => s.types);
  const regions = useStore((s) => s.regions);
  const scope = useStore((s) => s.scope);
  const d = useDerived();
  const [menu, setMenu] = useState<{ id: string; left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sel: Sel | null = scope.kind === 'filter' ? scope.sel : null;

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [menu]);

  const onChip = (typeId: string, multi: boolean) => {
    if (multi && sel) {
      const next = { ...sel };
      if (typeId in next) delete next[typeId];
      else next[typeId] = null;
      applySel(next);
      return;
    }
    const only = sel && Object.keys(sel).length === 1 && typeId in sel && sel[typeId] === null;
    applySel(only ? {} : { [typeId]: null });
  };

  const toggleRegion = (typeId: string, regionId: string) => {
    const base: Sel = sel ? { ...sel } : {};
    const cur = base[typeId];
    let list: string[];
    if (cur === undefined || cur === null) list = [regionId];
    else list = cur.includes(regionId) ? cur.filter((r) => r !== regionId) : [...cur, regionId];
    if (list.length) base[typeId] = list;
    else delete base[typeId];
    applySel(base);
  };

  return (
    <div className="type-chips">
      {types.map((t) => {
        const count = d.countByType.get(t.id) ?? 0;
        const on = !!sel && t.id in sel;
        const regs = sel?.[t.id];
        const partial = on && Array.isArray(regs);
        const regionOptions = [
          ...regions.map((r) => ({ id: r.id, name: r.name })),
          { id: NO_REGION, name: '未设国籍' },
        ].map((r) => ({ ...r, count: d.countByTypeRegion.get(`${t.id}|${r.id}`) ?? 0 }));
        return (
          <div key={t.id} className={`type-chip ${on ? 'on' : ''} ${sel && !on ? 'off' : ''}`} style={{ '--c': t.color, '--fg': readableOn(t.color) } as CSSProperties}>
            <button
              className="type-chip-main"
              onClick={(e) => onChip(t.id, e.ctrlKey || e.metaKey || e.shiftKey)}
              title={`筛选「${t.name}」并点亮（Ctrl/Shift 点击可多选）`}
            >
              <span className="ic">{t.icon}</span>
              {t.name}
              {partial && <span className="sub">·{(regs as string[]).map((r) => (r === NO_REGION ? '未设' : regions.find((x) => x.id === r)?.name ?? '?')).join('/')}</span>}
              <span className="n">{count}</span>
            </button>
            <button
              className="type-chip-more"
              onClick={(e) => {
                if (menu?.id === t.id) {
                  setMenu(null);
                  return;
                }
                const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                setMenu({ id: t.id, left: Math.min(r.left, window.innerWidth - 230), top: r.bottom + 6 });
              }}
              title="按国籍（子类型）筛选"
            >
              <ChevronDown size={13} />
            </button>
            {menu?.id === t.id && (
              <div className="popover region-menu" ref={menuRef} style={{ position: 'fixed', left: menu.left, top: menu.top }}>
                <div className="popover-title">{t.name} · 按国籍筛选</div>
                <button
                  className={`menu-item ${on && regs === null ? 'on' : ''}`}
                  onClick={() => {
                    applySel({ ...(sel ?? {}), [t.id]: null });
                    setMenu(null);
                  }}
                >
                  <span className="check">{on && regs === null && <Check size={14} />}</span>
                  全部
                  <span className="n">{count}</span>
                </button>
                {regionOptions.map((r) => {
                  const checked = Array.isArray(regs) && regs.includes(r.id);
                  return (
                    <button key={r.id} className={`menu-item ${checked ? 'on' : ''} ${r.count ? '' : 'muted'}`} onClick={() => toggleRegion(t.id, r.id)}>
                      <span className="check">{checked && <Check size={14} />}</span>
                      {r.name}
                      <span className="n">{r.count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

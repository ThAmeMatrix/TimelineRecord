import { createContext, useCallback, useContext, useDeferredValue, useMemo, type ReactNode } from 'react';
import { useStore } from '../store';
import type { Region, TLNode, TLType } from '../types';
import { camera } from './camera';
import { dateEnd, dateStart } from './dates';
import type { Item } from './layout';
import { inScope, NO_REGION } from './scope';
import { norm, splitTerms, titleKey } from './text';

export interface Derived {
  /** 全部节点，按时间排序 */
  items: Item[];
  byId: Map<string, Item>;
  indexById: Map<string, number>;
  typeById: Map<string, TLType>;
  regionById: Map<string, Region>;
  /** 同名分组（标题键 → 节点） */
  titleGroups: Map<string, Item[]>;
  /** 当前点亮范围内的节点 */
  members: Set<string> | null;
  /** 搜索命中（在点亮范围内） */
  matches: Set<string> | null;
  /** 实际高亮集合 = matches ?? members */
  highlight: Set<string> | null;
  /** 可跳转的节点序列 */
  nav: Item[] | null;
  terms: string[];
  countByType: Map<string, number>;
  countByTypeRegion: Map<string, number>;
}

const Ctx = createContext<Derived | null>(null);

const hayCache = new WeakMap<TLNode, { key: string; hay: string }>();

function haystack(n: TLNode, typeName: string, regionName: string): string {
  const key = `${typeName}|${regionName}`;
  const hit = hayCache.get(n);
  if (hit && hit.key === key) return hit.hay;
  const hay = norm([n.title, titleKey(n.title), n.label, typeName, regionName, n.start, n.end ?? '', n.summary, n.commentText].join('\n'));
  hayCache.set(n, { key, hay });
  return hay;
}

export function DerivedProvider({ children }: { children: ReactNode }) {
  const nodes = useStore((s) => s.nodes);
  const types = useStore((s) => s.types);
  const regions = useStore((s) => s.regions);
  const scope = useStore((s) => s.scope);
  const board = useStore((s) => s.board);
  const query = useDeferredValue(useStore((s) => s.query));

  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  const regionById = useMemo(() => new Map(regions.map((r) => [r.id, r])), [regions]);

  const items = useMemo(() => {
    const order = new Map(types.map((t, i) => [t.id, i]));
    // 只取当前看板的节点：正式时光轴 / 备选观看互不相见
    const list: Item[] = Object.values(nodes)
      .filter((n) => (n.board ?? 'main') === board)
      .map((n) => ({ n, t0: dateStart(n.start), t1: n.end ? dateEnd(n.end) : null }));
    list.sort(
      (a, b) =>
        a.t0 - b.t0 ||
        (order.get(a.n.typeId) ?? 999) - (order.get(b.n.typeId) ?? 999) ||
        a.n.title.localeCompare(b.n.title, 'zh-CN') ||
        a.n.createdAt - b.n.createdAt,
    );
    return list;
  }, [nodes, types, board]);

  const byId = useMemo(() => new Map(items.map((it) => [it.n.id, it])), [items]);
  const indexById = useMemo(() => new Map(items.map((it, i) => [it.n.id, i])), [items]);

  const titleGroups = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of items) {
      const k = titleKey(it.n.title);
      const list = m.get(k);
      if (list) list.push(it);
      else m.set(k, [it]);
    }
    return m;
  }, [items]);

  const members = useMemo(() => {
    if (scope.kind === 'none') return null;
    const set = new Set<string>();
    for (const it of items) if (inScope(it.n, scope)) set.add(it.n.id);
    return set;
  }, [items, scope]);

  const terms = useMemo(() => splitTerms(query), [query]);

  const matches = useMemo(() => {
    if (!terms.length) return null;
    const set = new Set<string>();
    for (const it of items) {
      if (members && !members.has(it.n.id)) continue;
      const typeName = typeById.get(it.n.typeId)?.name ?? '';
      const regionName = it.n.regionId ? (regionById.get(it.n.regionId)?.name ?? '') : '';
      const hay = haystack(it.n, typeName, regionName);
      if (terms.every((t) => hay.includes(t))) set.add(it.n.id);
    }
    return set;
  }, [items, members, terms, typeById, regionById]);

  const highlight = matches ?? members;
  const nav = useMemo(() => (highlight ? items.filter((it) => highlight.has(it.n.id)) : null), [items, highlight]);

  const counts = useMemo(() => {
    const byType = new Map<string, number>();
    const byTypeRegion = new Map<string, number>();
    for (const it of items) {
      byType.set(it.n.typeId, (byType.get(it.n.typeId) ?? 0) + 1);
      const k = `${it.n.typeId}|${it.n.regionId ?? NO_REGION}`;
      byTypeRegion.set(k, (byTypeRegion.get(k) ?? 0) + 1);
    }
    return { byType, byTypeRegion };
  }, [items]);

  const value = useMemo<Derived>(
    () => ({
      items,
      byId,
      indexById,
      typeById,
      regionById,
      titleGroups,
      members,
      matches,
      highlight,
      nav,
      terms,
      countByType: counts.byType,
      countByTypeRegion: counts.byTypeRegion,
    }),
    [items, byId, indexById, typeById, regionById, titleGroups, members, matches, highlight, nav, terms, counts],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDerived(): Derived {
  const v = useContext(Ctx);
  if (!v) throw new Error('DerivedProvider 缺失');
  return v;
}

/** 在当前跳转序列中前进/后退（没有点亮范围时在全部节点中按时间跳转） */
export function useNavigate() {
  const d = useDerived();
  return useCallback(
    (dir: 1 | -1) => {
      const s = useStore.getState();
      const list = d.nav ?? d.items;
      if (!list.length) return;
      const sel = s.selectedId;
      let idx = sel ? list.findIndex((it) => it.n.id === sel) : -1;
      if (idx >= 0) {
        idx = (idx + dir + list.length) % list.length;
      } else {
        const selIndex = sel != null ? d.indexById.get(sel) : undefined;
        if (selIndex != null) {
          // 以当前选中节点在全部节点中的位置为参照
          if (dir > 0) idx = list.findIndex((it) => (d.indexById.get(it.n.id) ?? 0) > selIndex);
          else idx = list.findLastIndex((it) => (d.indexById.get(it.n.id) ?? 0) < selIndex);
        } else {
          const ref = camera.centerTime();
          if (dir > 0) idx = list.findIndex((it) => it.t0 >= ref);
          else idx = list.findLastIndex((it) => it.t0 < ref);
        }
        if (idx < 0) idx = dir > 0 ? 0 : list.length - 1;
      }
      s.selectNode(list[idx].n.id, { keepScope: true, focus: 'center' });
    },
    [d],
  );
}

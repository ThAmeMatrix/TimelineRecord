import { ChevronLeft, ChevronRight, Eye, EyeOff, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useDerived, useNavigate } from '../lib/derived';
import { describeScope, scopeColor } from '../lib/scope';
import { useStore } from '../store';
import type { Relation } from '../types';

const RELATIONS: { key: Relation; label: string; hint: string }[] = [
  { key: 'title', label: '同名', hint: '点亮同名的所有节点（不同类型、不同季都会被点亮）  快捷键 1' },
  { key: 'type', label: '同类型', hint: '点亮同一主类型的节点  快捷键 2' },
  { key: 'subtype', label: '同子类', hint: '点亮同一主类型且同一国籍的节点  快捷键 3' },
];

export function SpotlightBar() {
  const d = useDerived();
  const scope = useStore((s) => s.scope);
  const relation = useStore((s) => s.relation);
  const selectedId = useStore((s) => s.selectedId);
  const query = useStore((s) => s.query);
  const hideOthers = useStore((s) => s.hideOthers);
  const navigate = useNavigate();

  const active = scope.kind !== 'none' || d.terms.length > 0;
  if (!active && !selectedId) return null;

  const list = d.nav ?? d.items;
  const idx = selectedId ? list.findIndex((it) => it.n.id === selectedId) : -1;
  const color = scopeColor(scope, d.typeById);
  const desc = describeScope(scope, d.typeById, d.regionById);
  const selected = selectedId ? d.byId.get(selectedId) : undefined;

  const clear = () => {
    const s = useStore.getState();
    s.setQuery('');
    s.setScope({ kind: 'none' });
    s.setHideOthers(false);
  };

  return (
    <div className="spot tl-noadd" style={{ '--spot': color } as CSSProperties}>
      {selected && (
        <div className="seg" role="radiogroup" aria-label="点亮方式">
          {RELATIONS.map((r) => (
            <button
              key={r.key}
              className={relation === r.key && scope.kind !== 'none' && !(scope.kind === 'filter' && scope.origin === 'bar') ? 'on' : ''}
              title={r.hint}
              onClick={() => useStore.getState().setRelation(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
      {(desc || query) && (
        <div className="spot-desc">
          {desc && <span className="spot-scope">{desc}</span>}
          {query && <span className="spot-q">搜索「{query}」</span>}
        </div>
      )}
      <div className="spot-nav">
        <button className="icon-btn" onClick={() => navigate(-1)} title="上一个（← / A）" disabled={!list.length}>
          <ChevronLeft size={18} />
        </button>
        <span className="spot-count" title={active ? '当前点亮的节点' : '全部节点'}>
          {list.length ? (
            <>
              <b>{idx >= 0 ? idx + 1 : '–'}</b> / {list.length}
            </>
          ) : (
            '无匹配'
          )}
        </span>
        <button className="icon-btn" onClick={() => navigate(1)} title="下一个（→ / D）" disabled={!list.length}>
          <ChevronRight size={18} />
        </button>
      </div>
      {active && (
        <>
          <button
            className={`spot-toggle ${hideOthers ? 'on' : ''}`}
            onClick={() => useStore.getState().setHideOthers(!hideOthers)}
            title="只显示点亮的节点（H）"
          >
            {hideOthers ? <EyeOff size={15} /> : <Eye size={15} />}
            仅显示
          </button>
          <button className="icon-btn" onClick={clear} title="清除点亮与搜索（Esc）">
            <X size={16} />
          </button>
        </>
      )}
    </div>
  );
}

import { CornerDownLeft, Search, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatShort } from '../lib/dates';
import { useDerived, useNavigate } from '../lib/derived';
import { CoverImg } from './Media';
import type { Item } from '../lib/layout';
import { describeScope } from '../lib/scope';
import { norm, snippet, titleKey } from '../lib/text';
import { useStore } from '../store';

export const SEARCH_INPUT_ID = 'tl-search';

export function focusSearch() {
  const el = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
  el?.focus();
  el?.select();
}

function highlightText(text: string, terms: string[]): ReactNode {
  if (!terms.length || !text) return text;
  const lower = norm(text);
  const marks: [number, number][] = [];
  for (const t of terms) {
    let i = lower.indexOf(t);
    while (i >= 0 && t) {
      marks.push([i, i + t.length]);
      i = lower.indexOf(t, i + t.length);
    }
  }
  if (!marks.length) return text;
  marks.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let pos = 0;
  marks.forEach(([s, e], k) => {
    if (s < pos) return;
    if (s > pos) out.push(text.slice(pos, s));
    out.push(<mark key={k}>{text.slice(s, e)}</mark>);
    pos = e;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

export function SearchBox() {
  const query = useStore((s) => s.query);
  const scope = useStore((s) => s.scope);
  const selectedId = useStore((s) => s.selectedId);
  const d = useDerived();
  const navigate = useNavigate();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!d.matches) return [] as Item[];
    const list = d.items.filter((it) => d.matches!.has(it.n.id));
    const inTitle = (it: Item) => {
      const t = norm(`${it.n.title} ${it.n.label}`);
      const k = titleKey(it.n.title);
      return d.terms.every((term) => t.includes(term) || k.includes(term));
    };
    return [...list.filter(inTitle), ...list.filter((it) => !inTitle(it))].slice(0, 100);
  }, [d.matches, d.items, d.terms]);

  useEffect(() => setActive(-1), [query]);

  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const jump = (it: Item) => {
    useStore.getState().selectNode(it.n.id, { keepScope: true, focus: 'center' });
  };

  const scopeLabel = describeScope(scope, d.typeById, d.regionById);
  const open = focused && query.trim().length > 0;

  return (
    <div className={`search ${focused ? 'focused' : ''}`}>
      <Search size={16} className="search-ic" />
      {scopeLabel && (
        <span className="search-scope" title="在当前点亮的范围内搜索">
          {scopeLabel}
        </span>
      )}
      <input
        id={SEARCH_INPUT_ID}
        value={query}
        placeholder={scopeLabel ? '在点亮范围内搜索…' : '搜索标题、简介、评论…（/）'}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => useStore.getState().setQuery(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(results.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(-1, a - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (active >= 0 && results[active]) jump(results[active]);
            else navigate(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (query) useStore.getState().setQuery('');
            else (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {query && (
        <button className="search-clear" onMouseDown={(e) => e.preventDefault()} onClick={() => useStore.getState().setQuery('')} title="清空">
          <X size={14} />
        </button>
      )}
      {open && (
        <div className="search-pop" ref={listRef} onMouseDown={(e) => e.preventDefault()}>
          <div className="search-pop-head">
            {results.length ? `${d.matches?.size ?? 0} 个结果` : '没有匹配的节点'}
            <span className="hint">
              <CornerDownLeft size={12} /> 跳到下一个 · Shift+Enter 上一个 · ↑↓ 选择
            </span>
          </div>
          {results.map((it, i) => {
            const type = d.typeById.get(it.n.typeId);
            const region = it.n.regionId ? d.regionById.get(it.n.regionId) : undefined;
            const t = norm(`${it.n.title} ${it.n.label}`);
            const titleHit = d.terms.every((term) => t.includes(term) || titleKey(it.n.title).includes(term));
            const snip = titleHit ? null : snippet(`${it.n.summary}\n${it.n.commentText}`, d.terms);
            return (
              <button
                key={it.n.id}
                data-idx={i}
                className={`search-row ${i === active ? 'active' : ''} ${it.n.id === selectedId ? 'current' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => jump(it)}
              >
                <span className="search-row-cv" style={{ '--c': type?.color } as CSSProperties}>
                  {it.n.coverThumb ? <CoverImg src={it.n.coverThumb} alt="" /> : <span>{type?.icon}</span>}
                </span>
                <span className="search-row-main">
                  <span className="search-row-title">
                    {highlightText(it.n.title, d.terms)}
                    {it.n.label && <em> {highlightText(it.n.label, d.terms)}</em>}
                  </span>
                  <span className="search-row-meta">
                    <span className="dot" style={{ background: type?.color }} />
                    {type?.name}
                    {region ? ` · ${region.name}` : ''} · {formatShort(it.n.start)}
                  </span>
                  {snip && (
                    <span className="search-row-snip">
                      {snip[0]}
                      <mark>{snip[1]}</mark>
                      {snip[2]}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          {d.matches && d.matches.size > results.length && <div className="search-more">仅显示前 {results.length} 条，用 Enter 逐个跳转查看全部</div>}
          {!results.length && scopeLabel && (
            <Fragment>
              <div className="search-more">
                当前只在「{scopeLabel}」中搜索。
                <button className="link-btn" onClick={() => useStore.getState().setScope({ kind: 'none' })}>
                  改为搜索全部
                </button>
              </div>
            </Fragment>
          )}
        </div>
      )}
    </div>
  );
}

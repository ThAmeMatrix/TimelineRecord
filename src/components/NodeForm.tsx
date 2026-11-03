import { Check, Loader2, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, imgSrc, type NodeInput } from '../api';
import { sourceAvailable } from '../local/sources';
import { formatShort, parseDateInput, todayString } from '../lib/dates';
import { useDerived } from '../lib/derived';
import { readableOn, titleKey } from '../lib/text';
import { useStore } from '../store';
import type { BoardId, Candidate, NodeDraft, Region } from '../types';
import { DatePicker } from './DatePicker';
import { Modal } from './Modal';

const LAST_TYPE_KEY = 'tl-last-type';

const REGION_ALIASES: Record<string, string[]> = {
  国产: ['中国大陆', '中国', '大陆', '内地', 'cn', '国产'],
  日本: ['日本', 'jp', 'japan'],
  美国: ['美国', 'us', 'usa', 'united states'],
  韩国: ['韩国', 'kr', 'south korea'],
};

const PALETTE = ['#ff6b8b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#748ffc', '#b197fc', '#f783ac', '#e599f7', '#94a3b8'];

export function matchRegion(regions: Region[], text?: string): string | null {
  if (!text) return null;
  const parts = text
    .toLowerCase()
    .split(/[\s/,，、]+/)
    .filter(Boolean);
  for (const r of regions) {
    const aliases = REGION_ALIASES[r.name] ?? [r.name.toLowerCase()];
    if (parts.some((p) => aliases.includes(p))) return r.id;
  }
  return null;
}

function relevance(c: Candidate, q: string): number {
  const a = titleKey(q);
  const names = [c.title, c.subtitle, ...(c.names ?? [])].filter((x): x is string => !!x).map(titleKey);
  if (names.includes(a)) return 3;
  if (names.some((n) => n.startsWith(a) || a.startsWith(n))) return 2;
  if (names.some((n) => n.includes(a) || a.includes(n))) return 1;
  return 0;
}

/** 从名称里提取季数信息：第三季/第3期/三期/3rd Season/S2 等 → {num, text}，没有则返回 null */
function matchSeason(text: string | undefined): { num: number; text: string } | null {
  const s = String(text ?? '');
  const re =
    /第\s*([0-9一二三四五六七八九十]+)\s*季|第\s*([0-9]+)\s*期|([0-9一二三四五六七八九十]+)\s*期|\b([0-9]+)(?:st|nd|rd|th)?\s*season\b|\bS([0-9]+)\b/i;
  const m = s.match(re);
  if (!m) return null;
  const raw = (m[1] || m[2] || m[3] || m[4] || m[5] || '').trim();
  const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const num = cn[raw] ?? Number(raw) ?? 0;
  return { num, text: m[0].trim() };
}

/** 从名称里提取季数：第三季/第3期/三期/3rd Season/S2 等 → 数字，没有则返回 0 */
function seasonNum(text: string | undefined): number {
  return matchSeason(text)?.num ?? 0;
}

/** 去掉名称里的季数词，得到用于检索的基础标题（如「咒术回战 第三季」→「咒术回战」） */
function stripSeason(text: string): string {
  return text
    .replace(/第\s*[0-9一二三四五六七八九十]+\s*季/g, ' ')
    .replace(/[0-9一二三四五六七八九十]+\s*季/g, ' ')
    .replace(/第\s*[0-9]+\s*期/g, ' ')
    .replace(/[0-9一二三四五六七八九十]+\s*期/g, ' ')
    .replace(/\b[0-9]+(?:st|nd|rd|th)?\s*season\b/gi, ' ')
    .replace(/\bS[0-9]+\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 用户指明季数时，构造多组检索词：基础标题、基础标题+季数词（如「咒术回战 第三季」）、原词，尽量命中「第N季」专属词条 */
function seasonQueries(q: string): string[] {
  const ms = matchSeason(q);
  if (!ms) return [q];
  const base = stripSeason(q);
  return Array.from(new Set([base, `${base} ${ms.text}`, q].map((s) => s.trim()).filter((s) => s.length >= 2)));
}

function mergeSuggestions(prev: Candidate[], add: Candidate[], q: string, order: string[]): Candidate[] {
  const seen = new Set(prev.map((c) => `${c.source}|${c.id}`));
  const qSeason = seasonNum(q);
  const all = [...prev, ...add.filter((c) => !seen.has(`${c.source}|${c.id}`) && !!c.title && !!(c.url || c.id))];
  return all
    .map((c) => {
      let s = relevance(c, q) * 10 - order.indexOf(c.source);
      const cSeason = seasonNum(c.title) || seasonNum(c.subtitle) || Math.max(0, ...(c.names ?? []).map(seasonNum));
      if (qSeason && cSeason) s += cSeason === qSeason ? 50 : -40;
      else if (qSeason && !cSeason) s -= 10; // 用户指明季数，但候选没标季的稍降权
      return { c, s };
    })
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c)
    .slice(0, 60);
    }

export function NodeForm({ nodeId, preset }: { nodeId?: string; preset?: Partial<NodeDraft> }) {
  const node = useStore((s) => (nodeId ? s.nodes[nodeId] : undefined));
  const types = useStore((s) => s.types);
  const regions = useStore((s) => s.regions);
  const profiles = useStore((s) => s.profiles);
  const sources = useStore((s) => s.sources);
  const close = useStore((s) => s.closeModal);
  const storeBoard = useStore((s) => s.board);
  const d = useDerived();
  const editing = !!node;

  const lastType = localStorage.getItem(LAST_TYPE_KEY);
  const [typeId, setTypeId] = useState(
    node?.typeId ?? preset?.typeId ?? (lastType && types.some((t) => t.id === lastType) ? lastType : (types[0]?.id ?? '')),
  );
  const [regionId, setRegionId] = useState<string | null>(node?.regionId ?? preset?.regionId ?? null);
  const [title, setTitle] = useState(node?.title ?? preset?.title ?? '');
  const [label, setLabel] = useState(node?.label ?? preset?.label ?? '');
  const [start, setStart] = useState(node?.start ?? preset?.start ?? '');
  const [end, setEnd] = useState(node?.end ?? preset?.end ?? '');
  const [created, setCreated] = useState(node?.created ?? preset?.created ?? '');
  const [summary, setSummary] = useState(node?.summary ?? preset?.summary ?? '');
  const [auto, setAuto] = useState(true);
  const [refetch, setRefetch] = useState(true);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState<{ kind: 'type' | 'region'; name: string } | null>(null);
  const [sugg, setSugg] = useState<{ q: string; loading: number; items: Candidate[] }>({ q: '', loading: 0, items: [] });
  const [suggOpen, setSuggOpen] = useState(false);
  const [suggActive, setSuggActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  /** 在搜索结果里按来源筛选；为空表示显示全部来源 */
  const [srcFilter, setSrcFilter] = useState<string[]>([]);
  /** 本表单要保存到的看板；点「移到时光轴」后在本表单内临时切到 main */
  const [boardOverride, setBoardOverride] = useState<BoardId | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const titleWrapRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const type = types.find((t) => t.id === typeId);
  const profile = type ? profiles[type.profile] : undefined;
  const isWork = !!type && type.profile !== 'none';
  const sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? id;

  const board: BoardId = boardOverride ?? (node ? (node.board ?? 'main') : (preset?.board ?? storeBoard));
  /** 备选观看：只填一个「记录时间」，正式观看时间留到移到时光轴后补 */
  const watch = board === 'watch';

  // 输入名称时联网给出候选条目（搜索该类型对应的全部可用源，不提前限定来源）
  useEffect(() => {
    if (!isWork || picked || !type) return;
    const q = title.trim();
    if (q.length < 2) {
      setSugg({ q: '', loading: 0, items: [] });
      return;
    }
    // 用户若指明了季数（如「第三季」），多组检索词齐发：基础标题 +「基础标题 第三季」+ 原词，
    // 既让各季都返回，又能直接命中「第N季」专属词条（如萌娘百科的「咒术回战 第三季」）
    const queries = seasonNum(q) ? seasonQueries(q) : [q];
    const all = (profile?.search ?? []).filter(sourceAvailable);
    if (!all.length) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      setSugg({ q, loading: all.length * queries.length, items: [] });
      for (const src of all) {
        for (const sq of queries) {
          if (!sq) continue;
          api
            .search(src, sq, type.profile, ctrl.signal)
            .then((r) =>
              setSugg((prev) => (prev.q !== q ? prev : { q, loading: prev.loading - 1, items: mergeSuggestions(prev.items, r.results, q, all) })),
            )
            .catch(() => setSugg((prev) => (prev.q !== q ? prev : { ...prev, loading: prev.loading - 1 })));
        }
      }
    }, 600);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, typeId, isWork, picked, profile, type]);

  useEffect(() => setSuggActive(-1), [sugg.items]);

  // 名称搜索框的响应范围：只在框内（输入框+候选列表）时才响应，点到框外即收起
  useEffect(() => {
    if (!suggOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      const inInput = titleRef.current && (t === titleRef.current || titleRef.current.contains(t));
      const inPop = !!popoverRef.current && popoverRef.current.contains(t);
      if (!inInput && !inPop) {
        setSuggOpen(false);
        setFocused(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [suggOpen]);

  // 结果里按来源聚合，用于筛选 chips
  const srcCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of sugg.items) m.set(c.source, (m.get(c.source) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [sugg.items]);

  // 应用来源筛选后的可见结果
  const shown = srcFilter.length ? sugg.items.filter((c) => srcFilter.includes(c.source)) : sugg.items;

  const pick = (c: Candidate) => {
    setPicked(c);
    setSuggOpen(false);
    const tk = titleKey(title);
    if (tk && titleKey(c.title).includes(tk) && titleKey(c.title) !== tk && title.trim().length < c.title.length) setTitle(c.title);
    const date = c.date && parseDateInput(c.date) ? parseDateInput(c.date) : c.year && parseDateInput(c.year) ? c.year : '';
    if (date) setStart((cur) => (cur.trim() ? cur : (date ?? '')));
    if (c.year) setCreated((cur) => (cur.trim() ? cur : String(c.year)));
    const r = matchRegion(regions, c.region);
    if (r) setRegionId((cur) => cur ?? r);
    if (c.hasDetail && !c.region) {
      api
        .detail(c.source, c.id, c.title)
        .then((det) => {
          const rr = matchRegion(regions, det.region);
          if (rr) setRegionId((cur) => cur ?? rr);
          if (det.year) {
            setStart((cur) => (cur.trim() ? cur : String(det.year)));
            setCreated((cur) => (cur.trim() ? cur : String(det.year)));
          }
        })
        .catch(() => {});
    }
  };

  const same = (d.titleGroups.get(titleKey(title)) ?? []).filter((it) => it.n.id !== nodeId);

  const submit = async () => {
    if (saving) return;
    setError('');
    const t = title.trim();
    if (!t) {
      setError('请填写名称');
      titleRef.current?.focus();
      return;
    }
    const s = parseDateInput(start);
    if (!s) {
      setError(start.trim() ? (watch ? '记录时间无法识别' : '开始时间无法识别') : watch ? '请填写记录时间' : '请填写开始时间');
      return;
    }
    let e: string | null = null;
    if (!watch && end.trim()) {
      e = parseDateInput(end);
      if (!e) {
        setError('结束时间无法识别');
        return;
      }
    }
    setSaving(true);
    const store = useStore.getState();
    try {
      if (node) {
        const patch: NodeInput = { typeId, regionId, title: t, label: label.trim(), start: s, end: e, created: created.trim() ? created : undefined };
        if ((node.board ?? 'main') !== board) patch.board = board;
        if (summary !== node.summary) patch.summary = summary;
        let n = await api.updateNode(node.id, patch);
        store.upsertNode(n);
        const renamed = t !== node.title || label.trim() !== node.label;
        if (picked) {
          n = await api.applyCandidate(node.id, picked, { cover: true, summary: true });
          store.upsertNode(n);
        } else if (renamed && refetch && isWork) {
          n = await api.autoMeta(n.id, { force: true, summary: summary === node.summary });
          store.upsertNode(n);
        }
        // 在两个看板之间搬动后，把界面也切过去，并保持选中，便于立刻看到
        const from = node.board ?? 'main';
        if (from !== board && store.board !== board) {
          store.setBoard(board);
          useStore.getState().selectNode(node.id, { focus: 'center' });
        }
        store.toast(
          from === 'watch' && board === 'main' ? '已移到时光轴' : from === 'main' && board === 'watch' ? '已移回备选' : '已保存',
          'success',
        );
      } else {
        const n = await api.createNode({
          typeId,
          regionId,
          title: t,
          label: label.trim(),
          start: s,
          end: e,
          created: created.trim() ? created : undefined,
          summary: summary.trim() ? summary : undefined,
          board,
          candidate: picked,
          auto: isWork && (auto || !!picked),
        });
        if (store.board !== board) store.setBoard(board);
        store.upsertNode(n);
        localStorage.setItem(LAST_TYPE_KEY, typeId);
        store.selectNode(n.id, { focus: 'center' });
        store.toast(`已添加「${t}」`, 'success');
      }
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const createInline = async () => {
    if (!adding?.name.trim()) {
      setAdding(null);
      return;
    }
    try {
      if (adding.kind === 'region') {
        const r = await api.createRegion(adding.name.trim());
        useStore.setState((s) => ({ regions: s.regions.some((x) => x.id === r.id) ? s.regions : [...s.regions, r] }));
        setRegionId(r.id);
      } else {
        const used = new Set(types.map((t) => t.color));
        const color = PALETTE.find((c) => !used.has(c)) ?? PALETTE[types.length % PALETTE.length];
        const t = await api.createType({ name: adding.name.trim(), color, icon: '', profile: 'generic' });
        useStore.setState((s) => ({ types: s.types.some((x) => x.id === t.id) ? s.types : [...s.types, t] }));
        setTypeId(t.id);
      }
      setAdding(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onFormKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const inlineAdd = (kind: 'type' | 'region') =>
    adding?.kind === kind ? (
      <span className="chip-input">
        <input
          autoFocus
          value={adding.name}
          placeholder={kind === 'type' ? '新类型名称' : '新国籍/地区'}
          onChange={(e) => setAdding({ kind, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void createInline();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setAdding(null);
            }
          }}
          onBlur={() => void createInline()}
        />
      </span>
    ) : (
      <button className="chip-btn add" onClick={() => setAdding({ kind, name: '' })} title={kind === 'type' ? '添加新的主类型' : '添加新的国籍/地区'}>
        <Plus size={13} />
      </button>
    );

  return (
    <Modal
      title={editing ? (watch ? '编辑备选' : '编辑节点') : watch ? '添加备选' : '添加节点'}
      onClose={close}
      width={620}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          <span className="foot-hint">Ctrl + Enter 保存</span>
          <button className="btn ghost" onClick={close}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={saving}>
            {saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
            {editing ? '保存' : '添加'}
          </button>
        </>
      }
    >
      <div className="form" onKeyDown={onFormKey}>
        <div className="field">
          <label>类型</label>
          <div className="chip-row">
            {types.map((t) => (
              <button
                key={t.id}
                className={`chip-btn ${t.id === typeId ? 'on' : ''}`}
                style={{ '--c': t.color, '--fg': readableOn(t.color) } as CSSProperties}
                onClick={() => setTypeId(t.id)}
              >
                <span>{t.icon}</span>
                {t.name}
              </button>
            ))}
            {inlineAdd('type')}
          </div>
        </div>

        <div className="field">
          <label>
            国籍 <span className="opt">可选</span>
          </label>
          <div className="chip-row">
            {regions.map((r) => (
              <button key={r.id} className={`chip-btn plain ${r.id === regionId ? 'on' : ''}`} onClick={() => setRegionId(r.id === regionId ? null : r.id)}>
                {r.name}
              </button>
            ))}
            {inlineAdd('region')}
          </div>
        </div>

        <div className="field">
          <label htmlFor="nf-title">名称</label>
          <div className="suggest-wrap" ref={titleWrapRef}>
            <input
              id="nf-title"
              ref={titleRef}
              className="input lg"
              value={title}
              autoFocus
              autoComplete="off"
              placeholder={isWork ? '作品名，输入后会联网匹配封面与简介' : '发生了什么'}
              onChange={(e) => {
                setTitle(e.target.value);
                setSuggOpen(true);
                setFocused(true);
                if (picked) setPicked(null);
              }}
              onFocus={() => {
                setSuggOpen(true);
                setFocused(true);
              }}
              onBlur={() => {
                setSuggOpen(false);
                setFocused(false);
              }}
              onKeyDown={(e) => {
                const list = shown;
                if (suggOpen && list.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault();
                  setSuggActive((a) => (e.key === 'ArrowDown' ? Math.min(list.length - 1, a + 1) : Math.max(-1, a - 1)));
                } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                  e.preventDefault();
                  if (suggOpen && suggActive >= 0 && list[suggActive]) pick(list[suggActive]);
                  else void submit();
                } else if (e.key === 'Escape' && suggOpen && list.length) {
                  e.stopPropagation();
                  setSuggOpen(false);
                }
              }}
            />
            {suggOpen && focused && !picked && isWork && sugg.q && (shown.length > 0 || sugg.loading > 0) && (
              <div className="suggest-pop" ref={popoverRef}>
                <div className="suggest-head">
                  {sugg.loading > 0 ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                  选一个条目，封面与简介会直接取自它（也可以不选，保存后自动匹配）
                  {srcCounts.length > 1 && <span className="muted"> · 共 {sugg.items.length} 条来自 {srcCounts.length} 个来源</span>}
                </div>
                {shown.map((c, i) => (
                  <button
                    key={`${c.source}|${c.id}`}
                    className={`suggest-row ${i === suggActive ? 'active' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSuggActive(i)}
                    onClick={() => pick(c)}
                  >
                    {c.cover ? (
                      <img src={imgSrc(c.cover)} alt="" loading="lazy" />
                    ) : (
                      <div className="cv-ph">{sourceName(c.source).slice(0, 1)}</div>
                    )}
                    <span className="suggest-main">
                      <span className="t">{c.title}</span>
                      <span className="s">{[c.subtitle, c.kind !== c.subtitle ? c.kind : '', c.year].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="src">{sourceName(c.source)}</span>
                  </button>
                ))}
                {sugg.loading > 0 && shown.length === 0 && <div className="suggest-empty">正在搜索…</div>}
              </div>
            )}
          </div>
          {picked && (
            <div className="picked">
              {picked.cover ? (
                <img src={imgSrc(picked.cover)} alt="" />
              ) : (
                <div className="cv-ph">{sourceName(picked.source).slice(0, 1)}</div>
              )}
              <div>
                <div className="t">已关联：{picked.title}</div>
                <div className="s">
                  {sourceName(picked.source)}
                  {picked.year ? ` · ${picked.year}` : ''}
                  {picked.kind ? ` · ${picked.kind}` : ''}
                </div>
              </div>
              <button className="icon-btn" onClick={() => setPicked(null)} title="取消关联">
                <X size={15} />
              </button>
            </div>
          )}
          {same.length > 0 && (
            <div className="same-hint">
              已有 {same.length} 个同名节点，会在时间轴上一起点亮：
              {same.slice(0, 6).map((it) => {
                const t = d.typeById.get(it.n.typeId);
                return (
                  <span key={it.n.id} className="same-pill" style={{ '--c': t?.color } as CSSProperties}>
                    {t?.icon} {t?.name}
                    {it.n.label ? ` ${it.n.label}` : ''} · {formatShort(it.n.start)}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {isWork && (
          <div className="field">
            <label>
              筛选结果来源 <span className="opt">可选，默认显示全部</span>
            </label>
            {srcCounts.length === 0 ? (
              <span className="date-hint inline">开始输入名称后，会按来源列出匹配结果</span>
            ) : (
              <div className="chip-row src-filter">
                <button className={`chip-btn plain ${srcFilter.length === 0 ? 'on' : ''}`} onClick={() => setSrcFilter([])}>
                  全部
                </button>
                {srcCounts.map(([id, n]) => (
                  <button
                    key={id}
                    className={`chip-btn plain ${srcFilter.includes(id) ? 'on' : ''}`}
                    onClick={() => setSrcFilter((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
                    title={`只看来自 ${sourceName(id)} 的结果`}
                  >
                    {sourceName(id)} <span className="cnt">{n}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="field">
          <label htmlFor="nf-label">
            副标题 <span className="opt">可选</span>
          </label>
          <input
            id="nf-label"
            className="input"
            value={label}
            autoComplete="off"
            placeholder={isWork ? '如：第二季、剧场版、第 1 卷、重温' : '补充说明'}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        <div className="field">
          <label>{watch ? '记录时间' : '时间'}</label>
          <div className="date-row">
            <div className="date-col">
              <DatePicker value={start} onChange={setStart} placeholder={watch ? '何时记下的，如 2013-04-07' : '开始，如 2013-04-07'} />
              <button
                className="btn ghost sm"
                onClick={() => setStart(todayString())}
                title={watch ? '记录时间设为今天' : '开始时间设为今天'}
              >
                设置为今天
              </button>
            </div>
            {!watch && (
              <>
                <span className="date-sep">至</span>
                <div className="date-col">
                  <DatePicker value={end} onChange={setEnd} placeholder="结束（可选）" />
                  <button className="btn ghost sm" onClick={() => setEnd(todayString())} title="结束时间设为今天">
                    设置为今天
                  </button>
                </div>
              </>
            )}
          </div>
          {watch ? (
            <>
              <span className="date-hint inline">只记一个时间（何时记下的）。真正看过后可移到时光轴补填观看时间。</span>
              <div className="row-end">
                <button className="btn ghost sm" onClick={() => setBoardOverride('main')} title="切到时光轴，改填正式的观看时间">
                  移到时光轴，补填观看时间
                </button>
              </div>
            </>
          ) : (
            <div className="row-end">
              <button
                className="btn ghost sm"
                onClick={() => {
                  setEnd('');
                  setBoardOverride('watch');
                }}
                title="移回备选观看，只保留一个记录时间"
              >
                移回备选，只留记录时间
              </button>
            </div>
          )}
        </div>

        {isWork && (
          <div className="field">
            <label>
              创作日期 <span className="opt">可选</span>
            </label>
            <DatePicker value={created} onChange={setCreated} placeholder="作品本身的创作/出版年份，如 1999" />
            <span className="date-hint inline">与上面的时间不同：常用于区分「作品诞生」与「本节点记录的事件」（如重看、连载）。</span>
          </div>
        )}

        <div className="field">
          <label htmlFor="nf-summary">
            {isWork ? '简介' : '描述'} <span className="opt">{isWork ? '留空会自动获取' : '可选'}</span>
          </label>
          <textarea id="nf-summary" className="input" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </div>

        {isWork && !editing && (
          <label className="check">
            <input type="checkbox" checked={auto || !!picked} disabled={!!picked} onChange={(e) => setAuto(e.target.checked)} />
            {picked ? '使用所选条目的封面与简介（缺失部分会自动补全）' : '保存后自动从网络获取封面与简介'}
          </label>
        )}
        {isWork && editing && node && (title.trim() !== node.title || label.trim() !== node.label) && (
          <label className="check">
            <input type="checkbox" checked={refetch} onChange={(e) => setRefetch(e.target.checked)} />
            名称已修改，保存后重新获取封面{summary === node.summary ? '与简介' : ''}
          </label>
        )}
      </div>
    </Modal>
  );
}

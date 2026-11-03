import { ExternalLink, ImageOff, Link2, Loader2, RefreshCw, Search, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, imgSrc } from '../api';
import { CoverImg } from './Media';
import { titleKey } from '../lib/text';
import { toastError, useStore } from '../store';
import type { Candidate, CandidateDetail } from '../types';
import { Modal } from './Modal';

type Mode = 'cover' | 'summary';

interface ResultState {
  status: 'loading' | 'done' | 'error';
  items: Candidate[];
  error?: string;
  req?: number;
}

const SUMMARY_FALLBACK = ['baike', 'wikipedia', 'bangumi', 'douban_book', 'anilist'];

function relevance(c: Candidate, q: string): number {
  const a = titleKey(q);
  if (!a) return 0;
  const names = [c.title, c.subtitle, ...(c.names ?? [])].filter((x): x is string => !!x).map(titleKey);
  if (names.includes(a)) return 3;
  if (names.some((n) => n.startsWith(a) || a.startsWith(n))) return 2;
  if (names.some((n) => n.includes(a) || a.includes(n))) return 1;
  return 0;
}

export function MetaPicker({ nodeId, mode: initialMode }: { nodeId: string; mode: Mode }) {
  const node = useStore((s) => s.nodes[nodeId]);
  const type = useStore((s) => s.types.find((t) => t.id === s.nodes[nodeId]?.typeId));
  const sources = useStore((s) => s.sources);
  const profiles = useStore((s) => s.profiles);
  const close = useStore((s) => s.closeModal);
  const profileKey = type?.profile ?? 'generic';
  const profile = profiles[profileKey] ?? profiles.generic;

  const [mode, setMode] = useState<Mode>(initialMode);
  const initialQuery = node ? [node.title, node.label].filter(Boolean).join(' ') : '';
  const [query, setQuery] = useState(initialQuery);
  const [submitted, setSubmitted] = useState(initialQuery);

  const usable = (id: string) => sources.find((s) => s.id === id)?.available ?? false;
  const defaults = (m: Mode): string[] => {
    if (m === 'cover') {
      const base = profile?.cover?.length ? profile.cover : ['baike', 'wikipedia', 'douban_movie', 'douban_book', 'bangumi'];
      return [...new Set([...base, 'bing', 'baidu_img'])].filter(usable);
    }
    return (profile?.summary?.length ? profile.summary : SUMMARY_FALLBACK).filter(usable);
  };
  const [enabled, setEnabled] = useState<string[]>(() => defaults(initialMode));
  const cache = useRef(new Map<string, ResultState>());
  const reqSeq = useRef(0);
  const [tick, rerender] = useReducer((x: number) => x + 1, 0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, { loading: boolean; data?: CandidateDetail; error?: string }>>({});
  const [withSummary, setWithSummary] = useState(false);
  const [applying, setApplying] = useState(false);
  const [editText, setEditText] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [previewBroken, setPreviewBroken] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const available = useMemo(
    () => sources.filter((s) => (mode === 'cover' ? true : s.summary)),
    [sources, mode],
  );

  // 防抖提交查询
  useEffect(() => {
    if (query === submitted) return;
    const t = window.setTimeout(() => setSubmitted(query.trim()), 550);
    return () => window.clearTimeout(t);
  }, [query, submitted]);

  // 按来源并行查询，结果逐个出现
  useEffect(() => {
    const q = submitted.trim();
    if (!q) return;
    const ctrl = new AbortController();
    const started: string[] = [];
    for (const src of enabled) {
      const key = `${src}|${q}`;
      const hit = cache.current.get(key);
      if (hit && hit.status !== 'error') continue;
      const req = ++reqSeq.current;
      cache.current.set(key, { status: 'loading', items: [], req });
      started.push(key);
      api
        .search(src, q, profileKey, ctrl.signal)
        .then((r) => {
          if (cache.current.get(key)?.req === req) cache.current.set(key, { status: 'done', items: r.results, req });
        })
        .catch((err: Error) => {
          if (cache.current.get(key)?.req !== req || err.name === 'AbortError') return;
          cache.current.set(key, { status: 'error', items: [], error: err.message, req });
        })
        .finally(rerender);
    }
    rerender();
    return () => {
      ctrl.abort();
      for (const key of started) if (cache.current.get(key)?.status === 'loading') cache.current.delete(key);
    };
  }, [submitted, enabled, profileKey]);

  const sections = useMemo(() => {
    const q = submitted.trim();
    return enabled
      .filter((src) => available.some((s) => s.id === src && s.available))
      .map((src) => {
        const state = cache.current.get(`${src}|${q}`) ?? { status: 'loading' as const, items: [] };
        let items = state.items;
        if (mode === 'cover') items = items.filter((c) => c.cover || c.coverLarge);
        else items = items.filter((c) => !c.imageOnly);
        const info = sources.find((s) => s.id === src);
        if (!info?.imageOnly) items = [...items].sort((a, b) => relevance(b, q) - relevance(a, q));
        return { src, name: info?.name ?? src, state, items };
      });
  }, [enabled, submitted, mode, sources, available, tick]);

  const flat = useMemo(() => sections.flatMap((s) => s.items.map((c) => ({ key: `${c.source}|${c.id}`, c }))), [sections]);
  const selected = flat.find((x) => x.key === selectedKey)?.c ?? null;

  useEffect(() => {
    setPreviewBroken(false);
    setEditText(null);
  }, [selectedKey]);

  // 选中需要详情的条目时拉取简介
  useEffect(() => {
    if (!selected || mode !== 'summary' || selected.summary || !selected.hasDetail) return;
    const key = `${selected.source}|${selected.id}`;
    if (details[key]) return;
    setDetails((m) => ({ ...m, [key]: { loading: true } }));
    api
      .detail(selected.source, selected.id, selected.title)
      .then((data) => setDetails((m) => ({ ...m, [key]: { loading: false, data } })))
      .catch((err: Error) => setDetails((m) => ({ ...m, [key]: { loading: false, error: err.message } })));
  }, [selected, mode, details]);

  if (!node) return null;

  const switchMode = (m: Mode) => {
    setMode(m);
    setEnabled(defaults(m));
    setSelectedKey(null);
  };

  const toggleSource = (id: string) => {
    setEnabled((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const retry = (src: string) => {
    cache.current.delete(`${src}|${submitted.trim()}`);
    setEnabled((cur) => [...cur]);
  };

  const finish = (msg: string) => {
    useStore.getState().toast(msg, 'success');
    close();
  };

  const apply = async (c: Candidate) => {
    if (applying) return;
    setApplying(true);
    try {
      const n = await api.applyCandidate(node.id, c, {
        cover: mode === 'cover',
        summary: mode === 'summary' || (withSummary && !c.imageOnly),
      });
      useStore.getState().upsertNode(n);
      finish(mode === 'cover' ? '封面已更新' : '简介已更新');
    } catch (err) {
      toastError(err);
    } finally {
      setApplying(false);
    }
  };

  const saveText = async (text: string, c: Candidate | null) => {
    setApplying(true);
    try {
      const n = await api.updateNode(node.id, { summary: text });
      useStore.getState().upsertNode(n);
      finish(c ? `简介已更新（基于${sources.find((s) => s.id === c.source)?.name ?? c.source}）` : '简介已更新');
    } catch (err) {
      toastError(err);
    } finally {
      setApplying(false);
    }
  };

  const uploadBlob = async (blob: Blob) => {
    setApplying(true);
    try {
      const n = await api.uploadCover(node.id, blob);
      useStore.getState().upsertNode(n);
      finish('封面已更新');
    } catch (err) {
      toastError(err);
    } finally {
      setApplying(false);
    }
  };

  const useUrl = async () => {
    const u = urlInput.trim();
    if (!u) return;
    setApplying(true);
    try {
      const n = await api.coverFromUrl(node.id, u);
      useStore.getState().upsertNode(n);
      finish('封面已更新');
    } catch (err) {
      toastError(err);
    } finally {
      setApplying(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    if (!flat.length) return;
    const idx = flat.findIndex((x) => x.key === selectedKey);
    let cols = 1;
    if (mode === 'cover' && gridRef.current) {
      const grid = gridRef.current.querySelector('.pk-grid') as HTMLElement | null;
      if (grid) cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    }
    let next = idx;
    if (e.key === 'ArrowRight') next = idx + 1;
    else if (e.key === 'ArrowLeft') next = idx - 1;
    else if (e.key === 'ArrowDown') next = idx < 0 ? 0 : idx + cols;
    else if (e.key === 'ArrowUp') next = idx - cols;
    else if (e.key === 'Enter' && selected) {
      e.preventDefault();
      void apply(selected);
      return;
    } else return;
    e.preventDefault();
    next = Math.max(0, Math.min(flat.length - 1, next));
    setSelectedKey(flat[next].key);
    gridRef.current?.querySelector(`[data-key="${CSS.escape(flat[next].key)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (mode !== 'cover') return;
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      void uploadBlob(file);
      return;
    }
    const text = e.clipboardData.getData('text');
    if ((e.target as HTMLElement).tagName !== 'INPUT' && /^https?:\/\/\S+$/i.test(text.trim())) {
      setUrlInput(text.trim());
    }
  };

  const detailState = selected ? details[`${selected.source}|${selected.id}`] : undefined;
  const fullSummary = selected ? selected.summary || detailState?.data?.summary || '' : '';
  const sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? id;
  const anyLoading = sections.some((s) => s.state.status === 'loading');

  return (
    <Modal title={`${mode === 'cover' ? '更换封面' : '更换简介'} · ${node.title}`} onClose={close} width="min(1120px, 94vw)" className="picker">
      <div className="pk" onKeyDown={onKeyDown} onPaste={onPaste} tabIndex={-1}>
        <div className="pk-top">
          <div className="seg">
            <button className={mode === 'cover' ? 'on' : ''} onClick={() => switchMode('cover')}>
              封面
            </button>
            <button className={mode === 'summary' ? 'on' : ''} onClick={() => switchMode('summary')}>
              简介
            </button>
          </div>
          <div className="pk-search">
            <Search size={15} />
            <input
              value={query}
              placeholder="换个关键词搜索"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setSubmitted(query.trim());
                }
              }}
            />
            {anyLoading && <Loader2 size={15} className="spin" />}
          </div>
          <div className="pk-sources">
            {available.map((s) => (
              <button
                key={s.id}
                className={`src-chip ${enabled.includes(s.id) && s.available ? 'on' : ''}`}
                onClick={() => toggleSource(s.id)}
                disabled={!s.available}
                title={s.note || undefined}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>

        <div className="pk-main">
          <div className="pk-results" ref={gridRef}>
            {sections.map((sec) => (
              <section key={sec.src} className="pk-sec">
                <div className="pk-sec-head">
                  <span className="name">{sec.name}</span>
                  {sec.state.status === 'loading' && <Loader2 size={13} className="spin" />}
                  {sec.state.status === 'done' && <span className="n">{sec.items.length}</span>}
                  {sec.state.status === 'error' && (
                    <span className="err">
                      {sec.state.error}
                      <button className="link-btn" onClick={() => retry(sec.src)}>
                        重试
                      </button>
                    </span>
                  )}
                </div>
                {mode === 'cover' ? (
                  <div className="pk-grid">
                    {sec.state.status === 'loading' && !sec.items.length
                      ? Array.from({ length: 6 }, (_, i) => <div key={i} className="pk-tile skeleton" />)
                      : sec.items.map((c) => {
                          const key = `${c.source}|${c.id}`;
                          return (
                            <button
                              key={key}
                              data-key={key}
                              className={`pk-tile ${key === selectedKey ? 'on' : ''}`}
                              onClick={() => setSelectedKey(key)}
                              onDoubleClick={() => void apply(c)}
                              title={c.title}
                            >
                              <img src={imgSrc(c.cover || c.coverLarge)} alt="" loading="lazy" onLoad={(e) => e.currentTarget.classList.add('ok')} />
                              <span className="cap">
                                <span className="t">{c.title || '（无标题）'}</span>
                                <span className="s">{[c.year, c.kind].filter(Boolean).join(' · ') || (c.width ? `${c.width}×${c.height}` : '')}</span>
                              </span>
                            </button>
                          );
                        })}
                    {sec.state.status === 'done' && !sec.items.length && <div className="pk-empty">没有结果</div>}
                  </div>
                ) : (
                  <div className="pk-list">
                    {sec.state.status === 'loading' && !sec.items.length
                      ? Array.from({ length: 2 }, (_, i) => <div key={i} className="pk-row skeleton" />)
                      : sec.items.map((c) => {
                          const key = `${c.source}|${c.id}`;
                          return (
                            <button
                              key={key}
                              data-key={key}
                              className={`pk-row ${key === selectedKey ? 'on' : ''}`}
                              onClick={() => setSelectedKey(key)}
                              onDoubleClick={() => void apply(c)}
                            >
                              {c.cover ? <img src={imgSrc(c.cover)} alt="" loading="lazy" /> : <span className="ph" />}
                              <span className="body">
                                <span className="t">
                                  {c.title}
                                  <em>{[c.year, c.kind].filter(Boolean).join(' · ')}</em>
                                </span>
                                <span className="s">{c.summary ? c.summary.slice(0, 120) : c.hasDetail ? '点击查看简介' : '该条目没有简介'}</span>
                              </span>
                            </button>
                          );
                        })}
                    {sec.state.status === 'done' && !sec.items.length && <div className="pk-empty">没有结果</div>}
                  </div>
                )}
              </section>
            ))}
            {!sections.length && <div className="pk-empty big">请在上方选择至少一个来源</div>}
          </div>

          <aside className="pk-preview">
            {selected ? (
              <>
                {mode === 'cover' ? (
                  <div className="pk-big">
                    {!previewBroken ? (
                      <img
                        key={selected.coverLarge || selected.cover}
                        src={imgSrc(selected.coverLarge || selected.cover)}
                        alt=""
                        onError={() => setPreviewBroken(true)}
                        onLoad={(e) => e.currentTarget.classList.add('ok')}
                      />
                    ) : (
                      <img src={imgSrc(selected.cover)} alt="" className="ok" />
                    )}
                  </div>
                ) : null}
                <div className="pk-info">
                  <div className="t">{selected.title}</div>
                  {selected.subtitle && <div className="s">{selected.subtitle}</div>}
                  <div className="s">{[sourceName(selected.source), selected.year, selected.kind].filter(Boolean).join(' · ')}</div>
                  {selected.url && (
                    <a className="link" href={selected.url} target="_blank" rel="noreferrer">
                      打开来源页 <ExternalLink size={12} />
                    </a>
                  )}
                </div>
                {mode === 'summary' && (
                  <div className="pk-summary">
                    {editText != null ? (
                      <textarea className="input" value={editText} onChange={(e) => setEditText(e.target.value)} autoFocus />
                    ) : detailState?.loading ? (
                      <div className="muted">
                        <Loader2 size={14} className="spin" /> 正在获取简介…
                      </div>
                    ) : fullSummary ? (
                      <p>{fullSummary}</p>
                    ) : (
                      <div className="muted">{detailState?.error ? `获取失败：${detailState.error}` : '这个条目没有可用的简介'}</div>
                    )}
                  </div>
                )}
                <div className="pk-actions">
                  {mode === 'cover' && !selected.imageOnly && (
                    <label className="check">
                      <input type="checkbox" checked={withSummary} onChange={(e) => setWithSummary(e.target.checked)} />
                      同时使用该条目的简介
                    </label>
                  )}
                  {mode === 'summary' && editText != null ? (
                    <>
                      <button className="btn ghost" onClick={() => setEditText(null)}>
                        取消编辑
                      </button>
                      <button className="btn primary" disabled={applying || !editText.trim()} onClick={() => void saveText(editText, selected)}>
                        保存简介
                      </button>
                    </>
                  ) : (
                    <>
                      {mode === 'summary' && fullSummary && (
                        <button className="btn ghost" onClick={() => setEditText(fullSummary)}>
                          编辑后使用
                        </button>
                      )}
                      <button
                        className="btn primary"
                        disabled={applying || (mode === 'summary' && !fullSummary)}
                        onClick={() => void apply(selected)}
                      >
                        {applying && <Loader2 size={15} className="spin" />}
                        {mode === 'cover' ? '使用此封面' : '使用此简介'}
                      </button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="pk-current">
                <div className="pk-label">当前{mode === 'cover' ? '封面' : '简介'}</div>
                {mode === 'cover' ? (
                  <>
                    <div className="pk-big">
                      {node.cover ? <CoverImg src={node.cover} alt="" className="ok" /> : <div className="pk-nocover"><ImageOff size={28} />暂无封面</div>}
                    </div>
                    {node.coverSource && <div className="muted small">来源：{sourceName(node.coverSource) || node.coverSource}</div>}
                    <div className="pk-upload">
                      <button className="btn" onClick={() => fileRef.current?.click()} disabled={applying}>
                        <Upload size={15} /> 上传本地图片
                      </button>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void uploadBlob(f);
                          e.target.value = '';
                        }}
                      />
                      <div className="url-row">
                        <Link2 size={15} />
                        <input className="input sm" value={urlInput} placeholder="粘贴图片链接" onChange={(e) => setUrlInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void useUrl()} />
                        <button className="btn sm" onClick={() => void useUrl()} disabled={!urlInput.trim() || applying}>
                          使用
                        </button>
                      </div>
                      <div className="muted small">也可以直接 Ctrl+V 粘贴截图</div>
                      {node.cover && (
                        <button
                          className="btn ghost danger sm"
                          onClick={async () => {
                            try {
                              useStore.getState().upsertNode(await api.clearCover(node.id));
                            } catch (err) {
                              toastError(err);
                            }
                          }}
                        >
                          <Trash2 size={14} /> 移除封面
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="pk-summary">{node.summary ? <p>{node.summary}</p> : <div className="muted">暂无简介</div>}</div>
                    <button className="btn" onClick={() => setEditText(node.summary)}>
                      手动编写
                    </button>
                    {editText != null && (
                      <div className="pk-manual">
                        <textarea className="input" value={editText} onChange={(e) => setEditText(e.target.value)} autoFocus rows={8} />
                        <button className="btn primary" disabled={applying} onClick={() => void saveText(editText, null)}>
                          保存
                        </button>
                      </div>
                    )}
                  </>
                )}
                <button
                  className="btn ghost sm"
                  onClick={async () => {
                    try {
                      useStore.getState().upsertNode(await api.autoMeta(node.id, { cover: mode === 'cover', summary: mode === 'summary', force: true }));
                      finish('已开始自动重新获取');
                    } catch (err) {
                      toastError(err);
                    }
                  }}
                >
                  <RefreshCw size={14} /> 让它自动重新匹配
                </button>
                <div className="muted small">← 从左侧选择一个结果预览；方向键选择，Enter 使用，双击直接使用</div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </Modal>
  );
}

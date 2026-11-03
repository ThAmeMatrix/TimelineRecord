import {
  ArrowRightLeft,
  CopyPlus,
  ExternalLink,
  ImagePlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Repeat,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { formatDate, formatRange } from '../lib/dates';
import { useDerived } from '../lib/derived';
import { titleKey, withAlpha } from '../lib/text';
import { toastError, useStore } from '../store';
import type { TLNode } from '../types';
import { Comments } from './comments/Comments';
import { CoverImg } from './Media';
import { Popover } from './Popover';

const SOURCE_NAMES: Record<string, string> = {
  bangumi: 'Bangumi',
  douban_movie: '豆瓣电影',
  douban_book: '豆瓣读书',
  anilist: 'AniList',
  baike: '百度百科',
  wikipedia: '维基百科',
  bing: '必应图片',
  baidu_img: '百度图片',
  upload: '本地上传',
  link: '图片链接',
  manual: '手动填写',
};

function Summary({ node }: { node: TLNode }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    setExpanded(false);
    setEditing(null);
  }, [node.id]);

  useEffect(() => {
    const el = ref.current;
    setOverflow(!!el && el.scrollHeight > el.clientHeight + 4);
  }, [node.summary, expanded]);

  const open = (mode: 'summary') => useStore.getState().openModal({ kind: 'picker', nodeId: node.id, mode });

  const save = async () => {
    if (editing == null) return;
    setSaving(true);
    try {
      useStore.getState().upsertNode(await api.updateNode(node.id, { summary: editing }));
      setEditing(null);
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="summary">
      <div className="sec-head">
        简介
        <span className="grow" />
        <button className="mini-btn" onClick={() => open('summary')} title="从其他来源搜索并替换简介">
          <Repeat size={13} /> 换源
        </button>
        <button className="mini-btn" onClick={() => setEditing(node.summary)} title="手动编辑">
          <Pencil size={13} /> 编辑
        </button>
      </div>
      {editing != null ? (
        <div className="summary-edit">
          <textarea
            className="input"
            rows={7}
            value={editing}
            autoFocus
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(null);
              }
            }}
          />
          <div className="row-end">
            <button className="btn ghost sm" onClick={() => setEditing(null)}>
              取消
            </button>
            <button className="btn primary sm" onClick={() => void save()} disabled={saving}>
              保存
            </button>
          </div>
        </div>
      ) : node.summary ? (
        <>
          <p ref={ref} className={`summary-text ${expanded ? 'open' : ''}`}>
            {node.summary}
          </p>
          <div className="summary-foot">
            {(overflow || expanded) && (
              <button className="link-btn" onClick={() => setExpanded((x) => !x)}>
                {expanded ? '收起' : '展开全部'}
              </button>
            )}
            <span className="grow" />
            {node.summarySource && (
              <span className="muted small">
                来源：
                {node.summaryUrl ? (
                  <a href={node.summaryUrl} target="_blank" rel="noreferrer">
                    {SOURCE_NAMES[node.summarySource] ?? node.summarySource} <ExternalLink size={11} />
                  </a>
                ) : (
                  (SOURCE_NAMES[node.summarySource] ?? node.summarySource)
                )}
              </span>
            )}
          </div>
        </>
      ) : node.metaStatus === 'pending' ? (
        <div className="muted small">
          <Loader2 size={13} className="spin" /> 正在从网络获取简介…
        </div>
      ) : (
        <div className="muted small">暂无简介，可以「换源」搜索或手动编辑。</div>
      )}
    </section>
  );
}

function PanelContent({ node }: { node: TLNode }) {
  const d = useDerived();
  const type = d.typeById.get(node.typeId);
  const region = node.regionId ? d.regionById.get(node.regionId) : undefined;
  const group = d.titleGroups.get(titleKey(node.title)) ?? [];
  const isWork = type?.profile !== 'none';
  const open = useStore((s) => s.openModal);

  const remove = () =>
    open({
      kind: 'confirm',
      title: '删除节点',
      message: `确定删除「${node.title}${node.label ? ` ${node.label}` : ''}」吗？它的封面与评论会一并删除。`,
      confirmText: '删除',
      danger: true,
      onConfirm: async () => {
        await api.deleteNode(node.id);
        useStore.getState().removeNode(node.id);
        useStore.getState().toast('已删除', 'success');
      },
    });

  const refetch = async () => {
    try {
      useStore.getState().upsertNode(await api.autoMeta(node.id, { force: true }));
    } catch (err) {
      toastError(err);
    }
  };

  /** 备选观看 → 时光轴：改看板后立刻打开表单补填正式观看时间 */
  const moveToMain = async () => {
    try {
      const n = await api.updateNode(node.id, { board: 'main', end: null });
      const s = useStore.getState();
      s.upsertNode(n);
      if (s.board !== 'main') s.setBoard('main');
      s.selectNode(n.id, { focus: 'center' });
      open({ kind: 'node-form', nodeId: n.id });
      useStore.getState().toast('已移到时光轴，请补填观看时间', 'success');
    } catch (err) {
      toastError(err);
    }
  };

  /** 时光轴 → 备选观看：只看板改回备选，结束时间清掉（备选只保留一个记录时间） */
  const moveToWatch = async () => {
    try {
      const n = await api.updateNode(node.id, { board: 'watch', end: null });
      const s = useStore.getState();
      s.upsertNode(n);
      if (s.board !== 'watch') s.setBoard('watch');
      s.selectNode(n.id, { focus: 'center' });
      useStore.getState().toast('已移回备选，只保留记录时间', 'success');
    } catch (err) {
      toastError(err);
    }
  };

  const status =
    node.metaStatus === 'pending'
      ? '正在获取封面与简介…'
      : node.metaStatus === 'failed'
        ? '没有自动找到封面或简介，可以手动换源'
        : node.metaStatus === 'partial'
          ? `部分信息没有找到（${!node.cover ? '封面' : '简介'}）`
          : '';

  const accent = node.coverColor || type?.color || '#7c9cff';

  return (
    <>
      <div className="panel-hero" style={{ '--hero': withAlpha(accent, 0.55) } as CSSProperties}>
        {node.cover && <CoverImg className="hero-bg" src={node.coverThumb || node.cover} alt="" aria-hidden />}
        <div className="hero-shade" />
        <button className="icon-btn panel-close" onClick={() => useStore.getState().selectNode(null)} title="关闭（Esc）">
          <X size={18} />
        </button>
        <div className="hero-row">
          <button className="hero-cover" onClick={() => open({ kind: 'picker', nodeId: node.id, mode: 'cover' })} title="更换封面">
            {node.cover ? (
              <CoverImg src={node.cover} alt="" onLoad={(e) => e.currentTarget.classList.add('ok')} />
            ) : (
              <span className="hero-ph">
                {node.metaStatus === 'pending' ? <Loader2 size={22} className="spin" /> : <ImagePlus size={22} />}
              </span>
            )}
            <span className="hero-cover-hint">换封面</span>
          </button>
          <div className="hero-info">
            <div className="hero-tags">
              <span className="tag" style={{ '--c': type?.color } as CSSProperties}>
                {type?.icon} {type?.name ?? '未知类型'}
              </span>
              {region && <span className="tag plain">{region.name}</span>}
            </div>
            <h2 className="hero-title">{node.title}</h2>
            {node.label && <div className="hero-label">{node.label}</div>}
            <div className="hero-date">
              {node.board === 'watch' ? `记录于 ${formatDate(node.start)}` : formatRange(node.start, node.end)}
            </div>
            {isWork && node.created && node.created !== node.start && (
              <div className="hero-created">创作于 {formatDate(node.created)}</div>
            )}
            {status && (
              <div className={`hero-status ${node.metaStatus}`}>
                {node.metaStatus === 'pending' && <Loader2 size={12} className="spin" />}
                {status}
              </div>
            )}
          </div>
        </div>
        <div className="hero-actions">
          {node.board === 'watch' ? (
            <button className="btn sm primary" onClick={() => void moveToMain()} title="移到时光轴，并补填正式的观看时间">
              <ArrowRightLeft size={14} /> 移到时光轴
            </button>
          ) : (
            <button className="btn sm" onClick={() => void moveToWatch()} title="移回备选观看，只保留一个记录时间">
              <ArrowRightLeft size={14} /> 移回备选
            </button>
          )}
          <button className="btn sm" onClick={() => open({ kind: 'node-form', nodeId: node.id })}>
            <Pencil size={14} /> 编辑
          </button>
          {isWork && (
            <button className="btn sm" onClick={() => open({ kind: 'picker', nodeId: node.id, mode: 'cover' })}>
              <Repeat size={14} /> 换封面
            </button>
          )}
          <button
            className="btn sm"
            title="添加一个同名节点（如续作、改编、重温）"
            onClick={() => open({ kind: 'node-form', preset: { title: node.title, regionId: node.regionId } })}
          >
            <CopyPlus size={14} /> 同名节点
          </button>
          <button className="btn sm danger" onClick={() => remove()} title="删除该节点">
            <Trash2 size={14} /> 删除
          </button>
          <Popover
            align="right"
            minWidth={210}
            trigger={({ toggle, ref }) => (
              <button ref={ref as React.Ref<HTMLButtonElement>} className="icon-btn" onClick={toggle} title="更多">
                <MoreHorizontal size={17} />
              </button>
            )}
          >
            {(close) => (
              <>
                {isWork && (
                  <button className="menu-item" onClick={() => { close(); void refetch(); }}>
                    <RefreshCw size={14} /> 重新自动获取封面与简介
                  </button>
                )}
              </>
            )}
          </Popover>
        </div>
      </div>

      <div className="panel-body">
        {group.length > 1 && (
          <section className="same">
            <div className="sec-head">
              同名节点 <span className="n">{group.length}</span>
              <span className="grow" />
              <span className="muted small">点击跳转</span>
            </div>
            <div className="same-strip">
              {group.map((it) => {
                const t = d.typeById.get(it.n.typeId);
                const cur = it.n.id === node.id;
                return (
                  <button
                    key={it.n.id}
                    className={`same-card ${cur ? 'cur' : ''}`}
                    style={{ '--c': t?.color } as CSSProperties}
                    onClick={() => useStore.getState().selectNode(it.n.id, { keepScope: true, focus: 'center' })}
                    title={`${it.n.title} ${it.n.label}`.trim()}
                  >
                    <span className="same-cv">{it.n.coverThumb ? <CoverImg src={it.n.coverThumb} alt="" /> : <span>{t?.icon}</span>}</span>
                    <span className="same-t">
                      {t?.icon} {t?.name}
                    </span>
                    <span className="same-s">{it.n.label || it.n.start.slice(0, 4)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <Summary node={node} />
        <Comments nodeId={node.id} />
      </div>
    </>
  );
}

export function DetailPanel() {
  const selectedId = useStore((s) => s.selectedId);
  const node = useStore((s) => (s.selectedId ? s.nodes[s.selectedId] : undefined));
  const [last, setLast] = useState<TLNode | undefined>(node);

  useEffect(() => {
    if (node) setLast(node);
  }, [node]);

  const shown = node ?? last;
  return (
    <aside className={`panel ${selectedId && node ? 'open' : ''}`} aria-hidden={!node}>
      {shown && <PanelContent key={shown.id} node={shown} />}
    </aside>
  );
}

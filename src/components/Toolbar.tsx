import {
  ArrowLeftRight,
  ArrowUpDown,
  CalendarClock,
  Columns3,
  Keyboard,
  Maximize2,
  MessageSquare,
  Plus,
  Rows3,
  Save,
  Settings,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useDerived } from '../lib/derived';
import { saveNow } from '../lib/persist';
import { fitItems, goToday, zoomBy } from '../lib/view';
import { useStore } from '../store';
import type { BoardId, Density } from '../types';
import { SearchBox } from './SearchBox';
import { TypeChips } from './TypeChips';

const BOARDS: { key: BoardId; label: string; hint: string }[] = [
  { key: 'main', label: '时光轴', hint: '正式记录：填写观看/经历的开始与结束时间' },
  { key: 'watch', label: '备选观看', hint: '先记下来，只填一个记录时间；之后可移到时光轴补填观看时间' },
];

const DENSITIES: { key: Density; label: string }[] = [
  { key: 'auto', label: '自动密度' },
  { key: 'poster', label: '海报' },
  { key: 'card', label: '卡片' },
  { key: 'chip', label: '紧凑' },
  { key: 'dot', label: '圆点' },
];

export function Toolbar() {
  const density = useStore((s) => s.density);
  const grouped = useStore((s) => s.grouped);
  const orientation = useStore((s) => s.orientation);
  const board = useStore((s) => s.board);
  const d = useDerived();
  const open = useStore((s) => s.openModal);
  const dirty = useStore((s) => s.dirty);

  return (
    <header className="toolbar">
      <div className="brand" title="时间轴记录">
        <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
          <path d="M4 16h24" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="10" cy="16" r="3.6" fill="#ff6b8b" />
          <circle cx="18" cy="16" r="3.6" fill="#4dabf7" />
          <circle cx="25" cy="16" r="2.6" fill="#69db7c" />
        </svg>
        <span>时间轴</span>
      </div>
      <div className="board-tabs" role="tablist" aria-label="看板">
        {BOARDS.map((b) => (
          <button
            key={b.key}
            role="tab"
            aria-selected={board === b.key}
            className={`board-tab ${board === b.key ? 'on' : ''}`}
            title={b.hint}
            onClick={() => useStore.getState().setBoard(b.key)}
          >
            {b.label}
          </button>
        ))}
      </div>
      <TypeChips />
      <div className="toolbar-spacer" />
      <SearchBox />
      <div className="tb-group">
        <select
          className="select sm"
          value={density}
          onChange={(e) => useStore.getState().setDensity(e.target.value as Density)}
          title="卡片密度：自动会根据缩放与拥挤程度在海报/卡片/紧凑/圆点间切换"
        >
          {DENSITIES.map((x) => (
            <option key={x.key} value={x.key}>
              {x.label}
            </option>
          ))}
        </select>
        <button
          className="icon-btn"
          title={orientation === 'v' ? '当前：纵向时间轴，点击切换为横向（V）' : '当前：横向时间轴，点击切换为纵向（V）'}
          onClick={() => useStore.getState().setOrientation(orientation === 'v' ? 'h' : 'v')}
        >
          {orientation === 'v' ? <ArrowUpDown size={17} /> : <ArrowLeftRight size={17} />}
        </button>
        <button
          className={`icon-btn ${grouped ? 'on' : ''}`}
          title="按类型分轨（G）"
          onClick={() => useStore.getState().setGrouped(!grouped)}
        >
          {orientation === 'v' ? <Columns3 size={17} /> : <Rows3 size={17} />}
        </button>
        <button className="icon-btn" title="缩小（-）" onClick={() => zoomBy(1.6)}>
          <ZoomOut size={17} />
        </button>
        <button className="icon-btn" title="放大（+）" onClick={() => zoomBy(1 / 1.6)}>
          <ZoomIn size={17} />
        </button>
        <button className="icon-btn" title="适配：铺满全部或当前点亮的节点（F）" onClick={() => fitItems(d.nav ?? d.items)}>
          <Maximize2 size={17} />
        </button>
        <button className="icon-btn" title="回到今天（T）" onClick={goToday}>
          <CalendarClock size={17} />
        </button>
        <button className="icon-btn" title="查看全部评论" onClick={() => open({ kind: 'comments' })}>
          <MessageSquare size={17} />
        </button>
        <button className="icon-btn" title="快捷键（?）" onClick={() => open({ kind: 'shortcuts' })}>
          <Keyboard size={17} />
        </button>
        <button className="icon-btn" title="类型、国籍与数据管理" onClick={() => open({ kind: 'settings' })}>
          <Settings size={17} />
        </button>
        <button
          className={`icon-btn save-btn ${dirty ? 'dirty' : ''}`}
          title={`${dirty ? '有未保存到文件的修改。' : '已保存。'}保存为 JSON 文件（Ctrl+S，另存为 Ctrl+Shift+S）\n数据会自动保存在浏览器中，导出文件用于备份与迁移`}
          onClick={() => void saveNow(false)}
        >
          <Save size={17} />
        </button>
      </div>
      <button
        className="btn primary"
        onClick={() => open({ kind: 'node-form' })}
        title={board === 'watch' ? '添加到备选观看，只填一个记录时间（N）' : '添加节点（N）'}
      >
        <Plus size={16} />
        {board === 'watch' ? '添加备选' : '添加'}
      </button>
    </header>
  );
}

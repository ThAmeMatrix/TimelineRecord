import { useEffect, useRef } from 'react';
import { ConfirmDialog, EmptyState, Lightbox, ShortcutsDialog, Toasts } from './components/Dialogs';
import { DetailPanel } from './components/DetailPanel';
import { MetaPicker } from './components/MetaPicker';
import { Minimap } from './components/Minimap';
import { NodeForm } from './components/NodeForm';
import { focusSearch } from './components/SearchBox';
import { Settings } from './components/Settings';
import { SpotlightBar } from './components/SpotlightBar';
import { Timeline } from './components/Timeline';
import { Toolbar } from './components/Toolbar';
import { CommentsModal } from './components/CommentsModal';
import { api } from './api';
import { DerivedProvider, useDerived, useNavigate } from './lib/derived';
import { saveNow } from './lib/persist';
import { fitItems, goToday, zoomBy } from './lib/view';
import { resumePending } from './local/auto';
import { detectBuiltinProxy } from './local/http';
import { connectEvents, useStore } from './store';

function Modals() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'node-form':
      return <NodeForm key={modal.nodeId ?? 'new'} nodeId={modal.nodeId} preset={modal.preset} />;
    case 'picker':
      return <MetaPicker key={`${modal.nodeId}-${modal.mode}`} nodeId={modal.nodeId} mode={modal.mode} />;
    case 'settings':
      return <Settings tab={modal.tab} />;
    case 'confirm':
      return <ConfirmDialog modal={modal} />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    case 'comments':
      return <CommentsModal />;
    default:
      return null;
  }
}

function Hotkeys() {
  const d = useDerived();
  const navigate = useNavigate();
  const dRef = useRef(d);
  const navRef = useRef(navigate);
  dRef.current = d;
  navRef.current = navigate;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest?.('input, textarea, select, [contenteditable="true"], .ProseMirror');

      if (e.key === 'Escape') {
        if (s.lightbox) {
          s.openLightbox(null);
        } else if (s.modal) {
          s.closeModal();
        } else if (typing) {
          target?.blur();
        } else if (s.query) {
          s.setQuery('');
        } else if (s.scope.kind !== 'none') {
          s.setScope({ kind: 'none' });
          s.setHideOthers(false);
        } else if (s.selectedId) {
          s.selectNode(null);
        }
        return;
      }
      if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault();
        void saveNow(e.shiftKey);
        return;
      }
      if (s.modal || s.lightbox) return;
      if ((e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

      const sel = s.selectedId ? s.nodes[s.selectedId] : null;
      const cur = dRef.current;
      switch (e.key) {
        case '/':
          e.preventDefault();
          focusSearch();
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          e.preventDefault();
          navRef.current(1);
          break;
        case 'ArrowLeft':
        case 'a':
        case 'A':
          e.preventDefault();
          navRef.current(-1);
          break;
        case '1':
          if (sel) s.setRelation('title');
          break;
        case '2':
          if (sel) s.setRelation('type');
          break;
        case '3':
          if (sel) s.setRelation('subtype');
          break;
        case 'h':
        case 'H':
          if (cur.highlight) s.setHideOthers(!s.hideOthers);
          break;
        case 'g':
        case 'G':
          s.setGrouped(!s.grouped);
          break;
        case 'v':
        case 'V':
          s.setOrientation(s.orientation === 'v' ? 'h' : 'v');
          break;
        case 'f':
        case 'F':
          fitItems(cur.nav ?? cur.items);
          break;
        case 't':
        case 'T':
          goToday();
          break;
        case '+':
        case '=':
          zoomBy(1 / 1.6);
          break;
        case '-':
        case '_':
          zoomBy(1.6);
          break;
        case 'n':
        case 'N':
          e.preventDefault();
          s.openModal({ kind: 'node-form' });
          break;
        case 'e':
        case 'E':
          if (sel) {
            e.preventDefault();
            s.openModal({ kind: 'node-form', nodeId: sel.id });
          }
          break;
        case 'Enter':
          if (sel) s.focusNode(sel.id, 'center', true);
          break;
        case 'Delete':
          if (sel) {
            s.openModal({
              kind: 'confirm',
              title: '删除节点',
              message: `确定删除「${sel.title}${sel.label ? ` ${sel.label}` : ''}」吗？它的封面与评论会一并删除。`,
              confirmText: '删除',
              danger: true,
              onConfirm: async () => {
                await api.deleteNode(sel.id);
                useStore.getState().removeNode(sel.id);
              },
            });
          }
          break;
        case '?':
          s.openModal({ kind: 'shortcuts' });
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}

function Shell() {
  const loaded = useStore((s) => s.loaded);
  const loadError = useStore((s) => s.loadError);
  const empty = useStore((s) => Object.keys(s.nodes).length === 0);
  const panelOpen = useStore((s) => !!s.selectedId && !!s.nodes[s.selectedId]);
  const orientation = useStore((s) => s.orientation);

  return (
    <div className={`app orient-${orientation} ${panelOpen ? 'panel-open' : ''}`}>
      <Toolbar />
      <main className="stage">
        <Timeline onOpenNode={(id) => useStore.getState().selectNode(id, { focus: 'center', zoom: true })} />
        <div className="bottom-dock">
          <SpotlightBar />
          {orientation === 'h' && <Minimap orient="h" />}
        </div>
        {orientation === 'v' && <Minimap orient="v" />}
        {loaded && empty && <EmptyState />}
        {!loaded && (
          <div className="loading">
            {loadError ? (
              <>
                无法读取本地数据：{loadError}
                <button className="btn sm" onClick={() => void useStore.getState().load()}>
                  重试
                </button>
              </>
            ) : (
              '加载中…'
            )}
          </div>
        )}
      </main>
      <DetailPanel />
      <Modals />
      <Lightbox />
      <Toasts />
      <Hotkeys />
    </div>
  );
}

export function App() {
  useEffect(() => {
    const off = connectEvents();
    void (async () => {
      await detectBuiltinProxy();
      await useStore.getState().load();
      if (!useStore.getState().loaded) return;
      resumePending();
      void navigator.storage?.persist?.().catch(() => false);
    })();
    return off;
  }, []);
  return (
    <DerivedProvider>
      <Shell />
    </DerivedProvider>
  );
}

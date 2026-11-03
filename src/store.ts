import { create } from 'zustand';
import { api } from './api';
import { inScope, relationScope } from './lib/scope';
import * as localDb from './local/db';
import { onProxyChange } from './local/http';
import { bus } from './local/util';
import type {
  BoardId,
  Density,
  NodeDraft,
  Orientation,
  Profile,
  ProfileInfo,
  Region,
  Relation,
  Scope,
  SourceInfo,
  TLNode,
  TLType,
} from './types';

export type SettingsTab = 'types' | 'regions' | 'data';

export type ModalState =
  | { kind: 'node-form'; nodeId?: string; preset?: Partial<NodeDraft> }
  | { kind: 'picker'; nodeId: string; mode: 'cover' | 'summary' }
  | { kind: 'settings'; tab?: SettingsTab }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      confirmText?: string;
      danger?: boolean;
      onConfirm: () => unknown;
    }
  | { kind: 'shortcuts' }
  | { kind: 'comments' };

export interface FocusRequest {
  id: string;
  /** center = 居中；reveal = 已在视野内就不动 */
  mode: 'center' | 'reveal';
  /** 是否同时缩放到舒适的大小 */
  zoom: boolean;
  tick: number;
}

export interface ToastItem {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
}

interface Prefs {
  relation: Relation;
  density: Density;
  grouped: boolean;
  orientation: Orientation;
  /** 当前看板：正式时光轴 / 备选观看 */
  board: BoardId;
}

const PREFS_KEY = 'tl-prefs';

function loadPrefs(): Prefs {
  const def: Prefs = { relation: 'title', density: 'auto', grouped: false, orientation: 'v', board: 'main' };
  try {
    const p = { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } as Prefs;
    if (p.orientation !== 'h' && p.orientation !== 'v') p.orientation = def.orientation;
    if (p.board !== 'main' && p.board !== 'watch') p.board = def.board;
    return p;
  } catch {
    return def;
  }
}

interface StoreState extends Prefs {
  loaded: boolean;
  loadError: string | null;
  /** 有尚未保存到 JSON 文件的修改 */
  dirty: boolean;
  types: TLType[];
  regions: Region[];
  nodes: Record<string, TLNode>;
  sources: SourceInfo[];
  profiles: Partial<Record<Profile, ProfileInfo>>;

  selectedId: string | null;
  scope: Scope;
  query: string;
  hideOthers: boolean;
  focus: FocusRequest | null;
  modal: ModalState | null;
  lightbox: string | null;
  toasts: ToastItem[];
  commentsVersion: Record<string, number>;

  load: () => Promise<void>;
  upsertNode: (n: TLNode) => void;
  removeNode: (id: string) => void;
  setTaxonomy: (t: { types: TLType[]; regions: Region[] }) => void;

  selectNode: (
    id: string | null,
    opts?: { keepScope?: boolean; focus?: 'center' | 'reveal' | false; zoom?: boolean },
  ) => void;
  focusNode: (id: string, mode?: 'center' | 'reveal', zoom?: boolean) => void;
  setRelation: (r: Relation) => void;
  setScope: (s: Scope) => void;
  setQuery: (q: string) => void;
  setHideOthers: (v: boolean) => void;
  setDensity: (d: Density) => void;
  setGrouped: (v: boolean) => void;
  setOrientation: (o: Orientation) => void;
  setBoard: (b: BoardId) => void;
  openModal: (m: ModalState) => void;
  closeModal: () => void;
  openLightbox: (src: string | null) => void;
  toast: (message: string, kind?: ToastItem['kind']) => void;
  dismissToast: (id: number) => void;
  bumpComments: (nodeId: string) => void;
}

let toastSeq = 0;

export const useStore = create<StoreState>()((set, get) => ({
  ...loadPrefs(),
  loaded: false,
  loadError: null,
  dirty: false,
  types: [],
  regions: [],
  nodes: {},
  sources: [],
  profiles: {},

  selectedId: null,
  scope: { kind: 'none' },
  query: '',
  hideOthers: false,
  focus: null,
  modal: null,
  lightbox: null,
  toasts: [],
  commentsVersion: {},

  async load() {
    try {
      const [state, src] = await Promise.all([api.state(), api.sources().catch(() => null)]);
      const nodes: Record<string, TLNode> = {};
      for (const n of state.nodes) nodes[n.id] = n;
      const sel = get().selectedId;
      set({
        loaded: true,
        loadError: null,
        dirty: localDb.isDirty(),
        types: state.types,
        regions: state.regions,
        nodes,
        selectedId: sel && nodes[sel] ? sel : null,
        ...(src ? { sources: src.sources, profiles: src.profiles } : {}),
      });
    } catch (err) {
      set({ loadError: (err as Error).message });
    }
  },

  upsertNode(n) {
    const prev = get().nodes[n.id];
    if (prev && prev.updatedAt > n.updatedAt) return;
    set((s) => ({ nodes: { ...s.nodes, [n.id]: n } }));
  },

  removeNode(id) {
    if (!get().nodes[id]) return;
    set((s) => {
      const nodes = { ...s.nodes };
      delete nodes[id];
      const modal = s.modal && 'nodeId' in s.modal && s.modal.nodeId === id ? null : s.modal;
      return { nodes, selectedId: s.selectedId === id ? null : s.selectedId, modal };
    });
  },

  setTaxonomy({ types, regions }) {
    set({ types, regions });
  },

  selectNode(id, opts = {}) {
    const s = get();
    if (!id) {
      const keep = s.scope.kind === 'filter' && s.scope.origin === 'bar';
      set({ selectedId: null, scope: keep ? s.scope : { kind: 'none' } });
      return;
    }
    const node = s.nodes[id];
    if (!node) return;
    let scope = s.scope;
    if (!opts.keepScope) {
      const keep = s.scope.kind === 'filter' && s.scope.origin === 'bar' && inScope(node, s.scope);
      if (!keep) scope = relationScope(node, s.relation);
    }
    const focus =
      opts.focus === false
        ? s.focus
        : { id, mode: opts.focus ?? 'reveal', zoom: !!opts.zoom, tick: (s.focus?.tick ?? 0) + 1 };
    set({ selectedId: id, scope, focus });
  },

  focusNode(id, mode = 'center', zoom = false) {
    set((s) => ({ focus: { id, mode, zoom, tick: (s.focus?.tick ?? 0) + 1 } }));
  },

  setRelation(relation) {
    const s = get();
    const node = s.selectedId ? s.nodes[s.selectedId] : null;
    set({ relation, ...(node ? { scope: relationScope(node, relation) } : {}) });
  },

  setScope(scope) {
    set({ scope });
  },

  setQuery(query) {
    set({ query });
  },

  setHideOthers(hideOthers) {
    set({ hideOthers });
  },

  setDensity(density) {
    set({ density });
  },

  setGrouped(grouped) {
    set({ grouped });
  },

  setOrientation(orientation) {
    set({ orientation });
  },

  setBoard(board) {
    // 切换看板后原选中节点不在当前看板里，清掉选中与点亮范围
    set({ board, selectedId: null, scope: { kind: 'none' }, focus: null });
  },

  openModal(modal) {
    set({ modal });
  },

  closeModal() {
    set({ modal: null });
  },

  openLightbox(lightbox) {
    set({ lightbox });
  },

  toast(message, kind = 'info') {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, kind }] }));
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 5200 : 2600);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  bumpComments(nodeId) {
    set((s) => ({ commentsVersion: { ...s.commentsVersion, [nodeId]: (s.commentsVersion[nodeId] ?? 0) + 1 } }));
  },
}));

useStore.subscribe((s, prev) => {
  if (
    s.relation !== prev.relation ||
    s.density !== prev.density ||
    s.grouped !== prev.grouped ||
    s.orientation !== prev.orientation ||
    s.board !== prev.board
  ) {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          relation: s.relation,
          density: s.density,
          grouped: s.grouped,
          orientation: s.orientation,
          board: s.board,
        }),
      );
    } catch {
      /* ignore */
    }
  }
});

export function toastError(err: unknown) {
  useStore.getState().toast((err as Error)?.message || String(err), 'error');
}

/** 本地数据变化（自动获取完成、分类变化、评论变化、其他标签页的修改）同步到界面 */
export function connectEvents(): () => void {
  const offBus = bus.on((e) => {
    const s = useStore.getState();
    switch (e.type) {
      case 'node':
        s.upsertNode(e.node);
        break;
      case 'node-removed':
        s.removeNode(e.id);
        break;
      case 'taxonomy':
        s.setTaxonomy({ types: localDb.listTypes(), regions: localDb.listRegions() });
        break;
      case 'reload':
        void s.load();
        break;
      case 'comments':
        s.bumpComments(e.nodeId);
        break;
      case 'dirty':
        useStore.setState({ dirty: e.dirty });
        break;
    }
  });
  let timer = 0;
  const offRemote = localDb.onRemoteChange(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      await localDb.reloadFromDisk();
      await useStore.getState().load();
      for (const id of Object.keys(useStore.getState().commentsVersion)) useStore.getState().bumpComments(id);
    }, 200);
  });
  const offProxy = onProxyChange(() => void refreshSources());
  return () => {
    offBus();
    offRemote();
    offProxy();
  };
}

export async function refreshSources(): Promise<void> {
  const src = await api.sources();
  useStore.setState({ sources: src.sources, profiles: src.profiles });
}

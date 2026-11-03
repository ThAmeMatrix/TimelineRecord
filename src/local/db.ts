/**
 * 本地数据仓库：全部记录常驻内存，写入时同步持久化到 IndexedDB。
 * 对外提供与原服务端一致的增删改查语义（校验、错误信息、评论全文索引等）。
 */
import type { BoardId, MetaStatus, Profile, Region, TLComment, TLNode, TLType } from '../types';
import * as idb from './idb';
import { deleteMedia } from './media';
import { ApiError, bus, isValidDate, markdownToText, newId, periodEnd, periodStart } from './util';

export const PROFILE_KEYS: Profile[] = ['anime', 'manga', 'novel', 'movie', 'tv', 'generic', 'none'];

export interface TypeRec extends TLType {
  createdAt: number;
}
export interface RegionRec extends Region {
  createdAt: number;
}
export type NodeRec = Omit<TLNode, 'commentCount' | 'commentText'>;
export type CommentRec = TLComment;

const mem = {
  types: new Map<string, TypeRec>(),
  regions: new Map<string, RegionRec>(),
  nodes: new Map<string, NodeRec>(),
  comments: new Map<string, CommentRec>(),
};

/** nodeId -> 评论（按时间排序）；评论纯文本索引 */
const byNode = new Map<string, CommentRec[]>();
const commentTextCache = new Map<string, string>();

const DEFAULT_TYPES: Omit<TypeRec, 'sort' | 'createdAt'>[] = [
  { id: 'anime', name: '动画', color: '#ff6b8b', icon: '🎞', profile: 'anime' },
  { id: 'manga', name: '漫画', color: '#ffa94d', icon: '📖', profile: 'manga' },
  { id: 'novel', name: '小说', color: '#69db7c', icon: '📚', profile: 'novel' },
  { id: 'movie', name: '电影', color: '#4dabf7', icon: '🎬', profile: 'movie' },
  { id: 'tv', name: '电视剧', color: '#b197fc', icon: '📺', profile: 'tv' },
  { id: 'daily', name: '日常', color: '#94a3b8', icon: '📌', profile: 'none' },
];

const DEFAULT_REGIONS = [
  { id: 'cn', name: '国产' },
  { id: 'jp', name: '日本' },
  { id: 'us', name: '美国' },
  { id: 'kr', name: '韩国' },
];

/* ------------------------------ 加载与变更通知 ------------------------------ */

let readyPromise: Promise<void> | null = null;

export function ready(): Promise<void> {
  if (!readyPromise) readyPromise = loadAll().catch((err) => {
    readyPromise = null;
    throw err;
  });
  return readyPromise;
}

async function loadAll(): Promise<void> {
  const [types, regions, nodes, comments, seeded] = await Promise.all([
    idb.getAll<TypeRec>('types'),
    idb.getAll<RegionRec>('regions'),
    idb.getAll<NodeRec>('nodes'),
    idb.getAll<CommentRec>('comments'),
    idb.kvGet<boolean>('seeded'),
  ]);
  mem.types = new Map(types.map((t) => [t.id, t]));
  mem.regions = new Map(regions.map((r) => [r.id, r]));
  mem.nodes = new Map(nodes.map((n) => [n.id, n]));
  mem.comments = new Map(comments.map((c) => [c.id, c]));
  rebuildCommentIndex();
  if (!seeded && mem.types.size === 0) {
    const now = Date.now();
    const t = DEFAULT_TYPES.map((x, i) => ({ ...x, sort: i, createdAt: now }));
    const r = mem.regions.size ? [] : DEFAULT_REGIONS.map((x, i) => ({ ...x, sort: i, createdAt: now }));
    for (const x of t) mem.types.set(x.id, x);
    for (const x of r) mem.regions.set(x.id, x);
    await idb.write([
      { store: 'types', put: t },
      { store: 'regions', put: r },
      { store: 'kv', put: [{ key: 'seeded', value: true }] },
    ]);
  } else if (!seeded) {
    await idb.kvSet('seeded', true);
  }
  changeSeq = (await idb.kvGet<number>('changeSeq')) ?? 0;
  savedSeq = (await idb.kvGet<number>('savedSeq')) ?? 0;
}

/** 其他标签页修改了数据：重新从 IndexedDB 读取 */
export async function reloadFromDisk(): Promise<void> {
  readyPromise = loadAll();
  await readyPromise;
}

/* ---------- 未保存（未导出）变更计数，用于工具栏的「保存」提示 ---------- */

let changeSeq = 0;
let savedSeq = 0;
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('timeline-record') : null;

export function isDirty(): boolean {
  return changeSeq > savedSeq;
}

export function onRemoteChange(fn: () => void): () => void {
  if (!channel) return () => {};
  const h = (e: MessageEvent) => {
    if (e.data?.type === 'changed') fn();
  };
  channel.addEventListener('message', h);
  return () => channel.removeEventListener('message', h);
}

let notifyTimer = 0;

/** 记录一次数据变更：持久化变更计数、通知其他标签页 */
function touched(ops: idb.WriteOp[]): idb.WriteOp[] {
  changeSeq++;
  const was = savedSeq >= changeSeq - 1;
  if (was) bus.emit({ type: 'dirty', dirty: true });
  window.clearTimeout(notifyTimer);
  notifyTimer = window.setTimeout(() => channel?.postMessage({ type: 'changed' }), 120);
  return [...ops, { store: 'kv', put: [{ key: 'changeSeq', value: changeSeq }] }];
}

export async function markSaved(): Promise<void> {
  savedSeq = changeSeq;
  await idb.kvSet('savedSeq', savedSeq);
  bus.emit({ type: 'dirty', dirty: false });
}

async function persist(ops: idb.WriteOp[]): Promise<void> {
  await idb.write(touched(ops));
}

/* ------------------------------ 校验辅助 ------------------------------ */

function cleanName(value: unknown, what: string, max = 40): string {
  const s = String(value ?? '').trim();
  if (!s) throw new ApiError(400, `${what}不能为空`);
  if (s.length > max) throw new ApiError(400, `${what}过长（最多 ${max} 个字符）`);
  return s;
}

function cleanColor(value: unknown): string {
  const s = String(value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : '#94a3b8';
}

function assertUniqueName(map: Map<string, { id: string; name: string }>, name: string, what: string, exceptId?: string) {
  const lower = name.toLowerCase();
  for (const x of map.values()) {
    if (x.id !== exceptId && x.name.toLowerCase() === lower) throw new ApiError(409, `已存在名为「${name}」的${what}`);
  }
}

const bySort = <T extends { sort: number; createdAt: number }>(a: T, b: T) => a.sort - b.sort || a.createdAt - b.createdAt;
const strip = <T extends { createdAt: number }>(x: T): Omit<T, 'createdAt'> => {
  const { createdAt: _c, ...rest } = x;
  void _c;
  return rest;
};

/* ------------------------------ 类型 ------------------------------ */

export function listTypes(): TLType[] {
  return [...mem.types.values()].sort(bySort).map(strip);
}

export function getType(id: string | null | undefined): TLType | null {
  const t = id ? mem.types.get(id) : undefined;
  return t ? strip(t) : null;
}

export async function createType(input: Partial<TLType>): Promise<TLType> {
  const name = cleanName(input.name, '类型名称', 20);
  assertUniqueName(mem.types, name, '类型');
  const profile = PROFILE_KEYS.includes(input.profile as Profile) ? (input.profile as Profile) : 'generic';
  const sort = Math.max(-1, ...[...mem.types.values()].map((t) => t.sort)) + 1;
  const rec: TypeRec = {
    id: newId('t_'),
    name,
    color: cleanColor(input.color),
    icon: String(input.icon ?? '').trim().slice(0, 4),
    profile,
    sort,
    createdAt: Date.now(),
  };
  mem.types.set(rec.id, rec);
  await persist([{ store: 'types', put: [rec] }]);
  bus.emit({ type: 'taxonomy' });
  return strip(rec);
}

export async function updateType(id: string, patch: Partial<TLType>): Promise<TLType> {
  const t = mem.types.get(id);
  if (!t) throw new ApiError(404, '类型不存在');
  const next = { ...t };
  if ('name' in patch) {
    next.name = cleanName(patch.name, '类型名称', 20);
    assertUniqueName(mem.types, next.name, '类型', id);
  }
  if ('color' in patch) next.color = cleanColor(patch.color);
  if ('icon' in patch) next.icon = String(patch.icon ?? '').trim().slice(0, 4);
  if ('profile' in patch && PROFILE_KEYS.includes(patch.profile as Profile)) next.profile = patch.profile as Profile;
  mem.types.set(id, next);
  await persist([{ store: 'types', put: [next] }]);
  bus.emit({ type: 'taxonomy' });
  return strip(next);
}

export async function deleteType(id: string, moveTo?: string): Promise<number> {
  if (!mem.types.has(id)) throw new ApiError(404, '类型不存在');
  if (mem.types.size <= 1) throw new ApiError(400, '至少需要保留一个类型');
  const affected = [...mem.nodes.values()].filter((n) => n.typeId === id);
  if (affected.length && (!moveTo || moveTo === id || !mem.types.has(moveTo))) {
    throw new ApiError(409, `该类型下还有 ${affected.length} 个节点，请选择要迁移到的类型`);
  }
  const now = Date.now();
  const moved = affected.map((n) => ({ ...n, typeId: moveTo!, updatedAt: now }));
  for (const n of moved) mem.nodes.set(n.id, n);
  mem.types.delete(id);
  await persist([
    { store: 'types', del: [id] },
    { store: 'nodes', put: moved },
  ]);
  if (moved.length) bus.emit({ type: 'reload' });
  else bus.emit({ type: 'taxonomy' });
  return moved.length;
}

export async function reorder(kind: 'types' | 'regions', ids: string[]): Promise<void> {
  const map = kind === 'types' ? mem.types : mem.regions;
  const changed: (TypeRec | RegionRec)[] = [];
  ids.forEach((id, i) => {
    const x = map.get(id);
    if (x && x.sort !== i) {
      const next = { ...x, sort: i };
      map.set(id, next as never);
      changed.push(next);
    }
  });
  await persist([{ store: kind, put: changed }]);
  bus.emit({ type: 'taxonomy' });
}

/* --------------------------- 国籍 / 地区 --------------------------- */

export function listRegions(): Region[] {
  return [...mem.regions.values()].sort(bySort).map(strip);
}

export function getRegion(id: string | null | undefined): Region | null {
  const r = id ? mem.regions.get(id) : undefined;
  return r ? strip(r) : null;
}

export async function createRegion(nameInput: string): Promise<Region> {
  const name = cleanName(nameInput, '国籍/地区名称', 20);
  assertUniqueName(mem.regions, name, '国籍/地区');
  const sort = Math.max(-1, ...[...mem.regions.values()].map((r) => r.sort)) + 1;
  const rec: RegionRec = { id: newId('r_'), name, sort, createdAt: Date.now() };
  mem.regions.set(rec.id, rec);
  await persist([{ store: 'regions', put: [rec] }]);
  bus.emit({ type: 'taxonomy' });
  return strip(rec);
}

export async function updateRegion(id: string, nameInput: string): Promise<Region> {
  const r = mem.regions.get(id);
  if (!r) throw new ApiError(404, '国籍/地区不存在');
  const name = cleanName(nameInput, '国籍/地区名称', 20);
  assertUniqueName(mem.regions, name, '国籍/地区', id);
  const next = { ...r, name };
  mem.regions.set(id, next);
  await persist([{ store: 'regions', put: [next] }]);
  bus.emit({ type: 'taxonomy' });
  return strip(next);
}

export async function deleteRegion(id: string): Promise<void> {
  if (!mem.regions.has(id)) throw new ApiError(404, '国籍/地区不存在');
  const now = Date.now();
  const changed = [...mem.nodes.values()].filter((n) => n.regionId === id).map((n) => ({ ...n, regionId: null, updatedAt: now }));
  for (const n of changed) mem.nodes.set(n.id, n);
  mem.regions.delete(id);
  await persist([
    { store: 'regions', del: [id] },
    { store: 'nodes', put: changed },
  ]);
  bus.emit({ type: 'reload' });
}

/* ------------------------------ 节点 ------------------------------ */

const COMMENT_TEXT_LIMIT = 4000;

function rebuildCommentIndex() {
  byNode.clear();
  commentTextCache.clear();
  for (const c of mem.comments.values()) {
    const list = byNode.get(c.nodeId);
    if (list) list.push(c);
    else byNode.set(c.nodeId, [c]);
  }
  for (const list of byNode.values()) list.sort((a, b) => a.createdAt - b.createdAt);
}

function reindexNode(nodeId: string) {
  const list = [...mem.comments.values()].filter((c) => c.nodeId === nodeId).sort((a, b) => a.createdAt - b.createdAt);
  if (list.length) byNode.set(nodeId, list);
  else byNode.delete(nodeId);
  commentTextCache.delete(nodeId);
}

function commentText(nodeId: string): string {
  const hit = commentTextCache.get(nodeId);
  if (hit !== undefined) return hit;
  let text = '';
  for (const c of byNode.get(nodeId) ?? []) {
    if (text.length >= COMMENT_TEXT_LIMIT) break;
    text = (text ? `${text} ` : '') + markdownToText(c.body).slice(0, COMMENT_TEXT_LIMIT);
  }
  commentTextCache.set(nodeId, text);
  return text;
}

function view(n: NodeRec): TLNode {
  return { ...n, commentCount: byNode.get(n.id)?.length ?? 0, commentText: commentText(n.id) };
}

export function listNodes(): TLNode[] {
  return [...mem.nodes.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.createdAt - b.createdAt)).map(view);
}

export function getNode(id: string | null | undefined): TLNode | null {
  const n = id ? mem.nodes.get(id) : undefined;
  return n ? view(n) : null;
}

export interface NodeInputLike {
  typeId?: string;
  regionId?: string | null;
  title?: string;
  label?: string;
  start?: string;
  end?: string | null;
  summary?: string;
  summarySource?: string;
  summaryUrl?: string;
  board?: BoardId;
}

function normalizeDate(value: unknown, field: string, required: boolean): string | null {
  const s = value == null ? '' : String(value).trim();
  if (!s) {
    if (required) throw new ApiError(400, `${field}不能为空`);
    return null;
  }
  if (!isValidDate(s)) throw new ApiError(400, `${field}格式应为 YYYY、YYYY-MM 或 YYYY-MM-DD，且日期必须有效`);
  return s;
}

function validateNode(input: NodeInputLike, existing: NodeRec | null): Partial<NodeRec> {
  const out: Partial<NodeRec> = {};
  if (!existing || 'typeId' in input) {
    if (!input.typeId || !mem.types.has(input.typeId)) throw new ApiError(400, '类型不存在');
    out.typeId = input.typeId;
  }
  if ('regionId' in input) {
    if (input.regionId && !mem.regions.has(input.regionId)) throw new ApiError(400, '国籍/地区不存在');
    out.regionId = input.regionId || null;
  }
  if (!existing || 'title' in input) out.title = cleanName(input.title, '名称', 200);
  if ('label' in input) out.label = String(input.label ?? '').trim().slice(0, 100);
  if (!existing || 'start' in input) out.start = normalizeDate(input.start, '开始时间', true)!;
  if ('end' in input) out.end = normalizeDate(input.end, '结束时间', false);
  if ('created' in input) out.created = normalizeDate(input.created, '创作日期', false) ?? undefined;
  if ('board' in input) out.board = input.board === 'watch' ? 'watch' : 'main';
  const start = out.start ?? existing?.start;
  const end = 'end' in out ? out.end : existing?.end;
  if (start && end && periodEnd(end) <= periodStart(start)) throw new ApiError(400, '结束时间不能早于开始时间');
  if ('summary' in input) {
    out.summary = String(input.summary ?? '').slice(0, 20000);
    out.summarySource = input.summarySource ? String(input.summarySource) : out.summary ? 'manual' : '';
    out.summaryUrl = input.summaryUrl ? String(input.summaryUrl) : '';
  }
  return out;
}

export async function createNode(input: NodeInputLike): Promise<TLNode> {
  const data = validateNode(input, null);
  const now = Date.now();
  const rec: NodeRec = {
    id: newId('n_'),
    typeId: data.typeId!,
    regionId: data.regionId ?? null,
    board: data.board ?? 'main',
    title: data.title!,
    label: data.label ?? '',
    start: data.start!,
    end: data.end ?? null,
    created: data.created ? (normalizeDate(data.created, '创作日期', false) ?? undefined) : undefined,
    summary: data.summary ?? '',
    summarySource: data.summarySource ?? '',
    summaryUrl: data.summaryUrl ?? '',
    cover: '',
    coverThumb: '',
    coverSource: '',
    coverUrl: '',
    coverColor: '',
    metaStatus: 'idle',
    meta: {},
    createdAt: now,
    updatedAt: now,
  };
  mem.nodes.set(rec.id, rec);
  await persist([{ store: 'nodes', put: [rec] }]);
  return view(rec);
}

/** 用户可编辑的字段 */
export async function updateNode(id: string, input: NodeInputLike): Promise<TLNode> {
  const existing = mem.nodes.get(id);
  if (!existing) throw new ApiError(404, '节点不存在');
  return writeNode(existing, validateNode(input, existing));
}

export interface InternalPatch {
  summary?: string;
  summarySource?: string;
  summaryUrl?: string;
  cover?: string;
  coverThumb?: string;
  coverSource?: string;
  coverUrl?: string;
  coverColor?: string;
  metaStatus?: MetaStatus;
  meta?: TLNode['meta'];
}

/** 自动获取、换源使用的更新；节点已被删除时返回 null */
export async function updateNodeInternal(id: string, patch: InternalPatch, opts: { silent?: boolean } = {}): Promise<TLNode | null> {
  const existing = mem.nodes.get(id);
  if (!existing) return null;
  const n = await writeNode(existing, patch, opts.silent);
  return n;
}

async function writeNode(existing: NodeRec, data: Partial<NodeRec>, silent = false): Promise<TLNode> {
  const next: NodeRec = { ...existing, ...data, updatedAt: Date.now() };
  mem.nodes.set(next.id, next);
  // 「获取中」只是界面状态，不算作需要保存的修改
  const onlyStatus = Object.keys(data).every((k) => k === 'metaStatus') && data.metaStatus === 'pending';
  if (onlyStatus) await idb.write([{ store: 'nodes', put: [next] }]);
  else await persist([{ store: 'nodes', put: [next] }]);
  const v = view(next);
  if (!silent) bus.emit({ type: 'node', node: v });
  return v;
}

export async function deleteNode(id: string): Promise<void> {
  const n = mem.nodes.get(id);
  if (!n) throw new ApiError(404, '节点不存在');
  const comments = byNode.get(id) ?? [];
  mem.nodes.delete(id);
  for (const c of comments) mem.comments.delete(c.id);
  byNode.delete(id);
  commentTextCache.delete(id);
  await persist([
    { store: 'nodes', del: [id] },
    { store: 'comments', del: comments.map((c) => c.id) },
  ]);
  await deleteMedia([n.cover, n.coverThumb]).catch(() => {});
  bus.emit({ type: 'node-removed', id });
}

/* ------------------------------ 评论 ------------------------------ */

const MAX_COMMENT = 200_000;

function cleanBody(body: unknown): string {
  const s = String(body ?? '');
  if (!s.trim()) throw new ApiError(400, '评论内容不能为空');
  if (s.length > MAX_COMMENT) throw new ApiError(413, '评论内容过长');
  return s;
}

export function listComments(nodeId: string): TLComment[] {
  return [...(byNode.get(nodeId) ?? [])];
}

export interface CommentWithNode extends TLComment {
  nodeTitle: string;
  nodeType?: string;
  typeColor?: string;
}

/** 所有节点的评论（按时间倒序），用于「查看全部评论」 */
export function allComments(): CommentWithNode[] {
  const out: CommentWithNode[] = [];
  for (const [nodeId, list] of byNode) {
    const n = mem.nodes.get(nodeId);
    for (const c of list) {
      out.push({ ...c, nodeId, nodeTitle: n?.title ?? '(已删除)', nodeType: n?.typeId, typeColor: n ? typeColorOf(n) : undefined });
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

function typeColorOf(n: NodeRec): string {
  return mem.types.get(n.typeId)?.color ?? '';
}

function emitCommentChange(nodeId: string) {
  const n = mem.nodes.get(nodeId);
  if (n) bus.emit({ type: 'node', node: view(n) });
  bus.emit({ type: 'comments', nodeId });
}

export async function createComment(nodeId: string, body: string): Promise<TLComment> {
  if (!mem.nodes.has(nodeId)) throw new ApiError(404, '节点不存在');
  const now = Date.now();
  const c: CommentRec = { id: newId('c_'), nodeId, body: cleanBody(body), createdAt: now, updatedAt: now };
  mem.comments.set(c.id, c);
  reindexNode(nodeId);
  await persist([{ store: 'comments', put: [c] }]);
  emitCommentChange(nodeId);
  return c;
}

export async function updateComment(id: string, body: string): Promise<TLComment> {
  const c = mem.comments.get(id);
  if (!c) throw new ApiError(404, '评论不存在');
  const next = { ...c, body: cleanBody(body), updatedAt: Date.now() };
  mem.comments.set(id, next);
  reindexNode(c.nodeId);
  await persist([{ store: 'comments', put: [next] }]);
  emitCommentChange(c.nodeId);
  return next;
}

export async function deleteComment(id: string): Promise<void> {
  const c = mem.comments.get(id);
  if (!c) throw new ApiError(404, '评论不存在');
  mem.comments.delete(id);
  reindexNode(c.nodeId);
  await persist([{ store: 'comments', del: [id] }]);
  emitCommentChange(c.nodeId);
}

/* --------------------------- 整库读写（导入导出用） --------------------------- */

export function snapshot() {
  return {
    types: [...mem.types.values()].sort(bySort),
    regions: [...mem.regions.values()].sort(bySort),
    nodes: [...mem.nodes.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)),
    comments: [...mem.comments.values()].sort((a, b) => a.createdAt - b.createdAt),
  };
}

export interface BulkData {
  types: TypeRec[];
  regions: RegionRec[];
  nodes: NodeRec[];
  comments: CommentRec[];
}

/** 批量写入（合并：同 id 覆盖；替换：先清空） */
export async function bulkWrite(data: BulkData, replace: boolean, extraOps: idb.WriteOp[] = []): Promise<void> {
  if (replace) {
    mem.types.clear();
    mem.regions.clear();
    mem.nodes.clear();
    mem.comments.clear();
  }
  for (const t of data.types) mem.types.set(t.id, t);
  for (const r of data.regions) mem.regions.set(r.id, r);
  for (const n of data.nodes) mem.nodes.set(n.id, n);
  for (const c of data.comments) if (mem.nodes.has(c.nodeId)) mem.comments.set(c.id, c);
  rebuildCommentIndex();
  const ops: idb.WriteOp[] = [
    { store: 'types', clear: replace, put: data.types },
    { store: 'regions', clear: replace, put: data.regions },
    { store: 'nodes', clear: replace, put: data.nodes },
    { store: 'comments', clear: replace, put: data.comments.filter((c) => mem.nodes.has(c.nodeId)) },
    ...extraOps,
  ];
  await persist(ops);
  bus.emit({ type: 'reload' });
}

/** 所有记录引用到的本地媒体地址 */
export function referencedText(): string[] {
  const out: string[] = [];
  for (const n of mem.nodes.values()) out.push(n.cover, n.coverThumb);
  for (const c of mem.comments.values()) out.push(c.body);
  return out;
}

export function counts() {
  return { types: mem.types.size, regions: mem.regions.size, nodes: mem.nodes.size, comments: mem.comments.size };
}

/**
 * JSON 保存 / 导入。
 * 文件格式（version 2）：类型、国籍、节点、评论，以及被引用的本地媒体（base64）。
 * 也能导入旧版服务端导出的 version 1 文件。
 */
import type { Profile } from '../types';
import * as db from './db';
import { desktop } from './desktop';
import * as idb from './idb';
import { collectMediaIds, listMedia, type MediaRecord } from './media';
import { ApiError, isValidDate } from './util';

export const APP_ID = 'timeline-record';
export const FORMAT_VERSION = 2;

interface MediaEntry {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  data: string;
}

/* ------------------------------ 媒体统计与清理 ------------------------------ */

/** 被节点、评论以及未发表的评论草稿引用的媒体 id */
function referencedIds(): Set<string> {
  const ids = new Set<string>();
  for (const t of db.referencedText()) collectMediaIds(t, ids);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) collectMediaIds(localStorage.getItem(k) ?? '', ids);
    }
  } catch {
    /* ignore */
  }
  return ids;
}

export async function mediaStats(): Promise<{ count: number; bytes: number; unused: number; unusedBytes: number }> {
  const all = await listMedia();
  const used = referencedIds();
  let bytes = 0;
  let unused = 0;
  let unusedBytes = 0;
  for (const m of all) {
    bytes += m.size;
    if (!used.has(m.id)) {
      unused++;
      unusedBytes += m.size;
    }
  }
  return { count: all.length, bytes, unused, unusedBytes };
}

export async function cleanupMedia(): Promise<{ count: number; bytes: number }> {
  const all = await listMedia();
  const used = referencedIds();
  const drop = all.filter((m) => !used.has(m.id));
  await idb.write([{ store: 'media', del: drop.map((m) => m.id) }]);
  return { count: drop.length, bytes: drop.reduce((s, m) => s + m.size, 0) };
}

/* ------------------------------ 导出 ------------------------------ */

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function buildExport(includeMedia: boolean): Promise<Blob> {
  const snap = db.snapshot();
  const main = {
    app: APP_ID,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    types: snap.types,
    regions: snap.regions,
    nodes: snap.nodes,
    comments: snap.comments,
    media: [] as MediaEntry[],
  };
  const head = JSON.stringify(main, null, 1);
  if (!includeMedia) return new Blob([head], { type: 'application/json' });

  const used = new Set<string>();
  for (const t of db.referencedText()) collectMediaIds(t, used);
  const media = (await listMedia()).filter((m) => used.has(m.id));
  // 媒体可能很大：逐个拼成 Blob 片段，避免生成一个巨大的字符串
  const cut = head.lastIndexOf('[]');
  const parts: BlobPart[] = [head.slice(0, cut), '['];
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    const meta = JSON.stringify({ id: m.id, name: m.name, mime: m.mime, size: m.size, createdAt: m.createdAt });
    parts.push(i ? ',\n' : '\n', `${meta.slice(0, -1)},"data":"`, await blobToBase64(m.blob), '"}');
  }
  parts.push(media.length ? '\n]' : ']', head.slice(cut + 2));
  return new Blob(parts, { type: 'application/json' });
}

export function exportFileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `timeline-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/* ------------------------------ 保存到文件 ------------------------------ */

interface FileHandleLike {
  name: string;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  getFile?(): Promise<File>;
}

type PickerWindow = Window & {
  showSaveFilePicker?: (o: unknown) => Promise<FileHandleLike>;
  showOpenFilePicker?: (o: unknown) => Promise<FileHandleLike[]>;
};

const PICKER_TYPES = [{ description: '时间轴数据（JSON）', accept: { 'application/json': ['.json'] } }];

export function canBindFile(): boolean {
  // 桌面版：主进程记住文件路径，Ctrl+S 直接覆盖
  if (desktop()) return true;
  // file:// 是透明（opaque）源，文件系统访问 API 既不可靠也无意义（没有可供绑定的“当前文件”）
  if (location.protocol === 'file:') return false;
  return typeof (window as PickerWindow).showSaveFilePicker === 'function';
}

export async function boundFileName(): Promise<string | null> {
  const d = desktop();
  if (d) return d.fileName().catch(() => null);
  const h = await idb.kvGet<FileHandleLike>('fileHandle').catch(() => undefined);
  return h?.name ?? null;
}

export async function unbindFile(): Promise<void> {
  await desktop()?.unbind().catch(() => {});
  await idb.write([{ store: 'kv', del: ['fileHandle'] }]);
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 保存为 JSON。支持文件系统访问 API 的浏览器会记住保存位置，之后 Ctrl+S 直接覆盖该文件；
 * 否则以下载的方式保存。返回保存到的文件名；用户取消时返回 null。
 */
export async function saveJson({ saveAs = false, includeMedia = true }: { saveAs?: boolean; includeMedia?: boolean } = {}): Promise<string | null> {
  // 桌面版：系统保存对话框，并记住位置供之后的 Ctrl+S 使用
  const d = desktop();
  if (d) {
    const blob = await buildExport(includeMedia);
    const saved = await d.saveJson({ text: await blob.text(), name: exportFileName(), saveAs });
    if (!saved) return null;
    await db.markSaved();
    return saved.name;
  }
  const w = window as PickerWindow;
  // file:// 下文件系统访问 API 不可靠：直接走下载分支
  if (w.showSaveFilePicker && location.protocol !== 'file:') {
    let handle: FileHandleLike | undefined = saveAs ? undefined : await idb.kvGet<FileHandleLike>('fileHandle').catch(() => undefined);
    if (handle?.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      const p = await handle.requestPermission?.({ mode: 'readwrite' }).catch(() => 'denied' as PermissionState);
      if (p !== 'granted') handle = undefined;
    }
    if (!handle) {
      try {
        handle = await w.showSaveFilePicker({ suggestedName: exportFileName(), types: PICKER_TYPES });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return null;
        throw err;
      }
    }
    const blob = await buildExport(includeMedia);
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    await idb.kvSet('fileHandle', handle).catch(() => {});
    await db.markSaved();
    return handle.name;
  }
  const name = exportFileName();
  download(await buildExport(includeMedia), name);
  await db.markSaved();
  return name;
}

/** 通过文件系统访问 API 打开文件（之后保存会写回该文件）；不支持时返回 undefined */
export async function pickOpenFile(): Promise<File | null | undefined> {
  // 桌面版：系统打开对话框，之后保存会写回同一个文件
  const d = desktop();
  if (d) {
    const opened = await d.openJson();
    if (!opened) return opened;
    return new File([opened.text], opened.name, { type: 'application/json' });
  }
  const w = window as PickerWindow;
  if (!w.showOpenFilePicker || location.protocol === 'file:') return undefined;
  let handles: FileHandleLike[];
  try {
    handles = await w.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;
    throw err;
  }
  const h = handles[0];
  const file = await h.getFile!();
  await idb.kvSet('fileHandle', h).catch(() => {});
  return file;
}

/* ------------------------------ 导入 ------------------------------ */

type Row = Record<string, unknown>;

const str = (v: unknown, d = '') => (v == null ? d : String(v));
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || d);
const PROFILE_KEYS: Profile[] = ['anime', 'manga', 'novel', 'movie', 'tv', 'generic', 'none'];

function parseMeta(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  try {
    const o = JSON.parse(String(v ?? '{}'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/** 旧版服务端的 /media/... 文件不在导出文件里：封面退回原始网络地址 */
function legacyCover(cover: string, coverUrl: string): string {
  if (!cover.startsWith('/media/')) return cover;
  return /^https?:\/\//i.test(coverUrl) ? coverUrl : '';
}

function normalize(data: Row): db.BulkData & { media: MediaEntry[] } {
  const v1 = Number(data.version) === 1;
  const pick = (r: Row, camel: string, snake: string) => (v1 ? r[snake] : (r[camel] ?? r[snake]));
  const now = Date.now();
  const arr = (k: string) => (Array.isArray(data[k]) ? (data[k] as Row[]).filter((x) => x && typeof x === 'object' && x.id) : []);

  const types = arr('types').map((r, i) => ({
    id: str(r.id),
    name: str(r.name, '未命名').slice(0, 20),
    color: /^#[0-9a-f]{6}$/i.test(str(r.color)) ? str(r.color).toLowerCase() : '#94a3b8',
    icon: str(r.icon).slice(0, 4),
    profile: PROFILE_KEYS.includes(r.profile as Profile) ? (r.profile as Profile) : 'generic',
    sort: num(r.sort, i),
    createdAt: num(pick(r, 'createdAt', 'created_at'), now),
  }));
  const regions = arr('regions').map((r, i) => ({
    id: str(r.id),
    name: str(r.name, '未命名').slice(0, 20),
    sort: num(r.sort, i),
    createdAt: num(pick(r, 'createdAt', 'created_at'), now),
  }));
  const nodes: db.NodeRec[] = [];
  for (const r of arr('nodes')) {
    const start = str(r.start);
    const endRaw = r.end == null || r.end === '' ? null : str(r.end);
    if (!isValidDate(start) || (endRaw && !isValidDate(endRaw))) continue;
    const coverUrl = str(pick(r, 'coverUrl', 'cover_url'));
    const cover = legacyCover(str(r.cover), coverUrl);
    const thumb = legacyCover(str(pick(r, 'coverThumb', 'cover_thumb')), coverUrl) || cover;
    const status = str(pick(r, 'metaStatus', 'meta_status'), 'idle');
    nodes.push({
      id: str(r.id),
      typeId: str(pick(r, 'typeId', 'type_id')),
      regionId: (pick(r, 'regionId', 'region_id') as string | null) || null,
      title: str(r.title, '未命名').slice(0, 200),
      label: str(r.label).slice(0, 100),
      start,
      end: endRaw,
      summary: str(r.summary),
      summarySource: str(pick(r, 'summarySource', 'summary_source')),
      summaryUrl: str(pick(r, 'summaryUrl', 'summary_url')),
      cover,
      coverThumb: thumb,
      coverSource: cover ? str(pick(r, 'coverSource', 'cover_source')) : '',
      coverUrl,
      coverColor: str(pick(r, 'coverColor', 'cover_color')),
      metaStatus: (['idle', 'done', 'partial', 'failed'].includes(status) ? status : 'idle') as db.NodeRec['metaStatus'],
      meta: parseMeta(r.meta),
      createdAt: num(pick(r, 'createdAt', 'created_at'), now),
      updatedAt: num(pick(r, 'updatedAt', 'updated_at'), now),
    });
  }
  const comments = arr('comments')
    .map((r) => ({
      id: str(r.id),
      nodeId: str(pick(r, 'nodeId', 'node_id')),
      body: str(r.body),
      createdAt: num(pick(r, 'createdAt', 'created_at'), now),
      updatedAt: num(pick(r, 'updatedAt', 'updated_at'), now),
    }))
    .filter((c) => c.nodeId && c.body.trim());
  const media = (Array.isArray(data.media) ? (data.media as Row[]) : [])
    .filter((m) => m && typeof m.id === 'string' && typeof m.data === 'string' && !String(m.id).includes('/'))
    .map((m) => ({
      id: str(m.id),
      name: str(m.name, str(m.id)),
      mime: str(m.mime, 'application/octet-stream'),
      size: num(m.size, 0),
      createdAt: num(m.createdAt, now),
      data: str(m.data),
    }));
  return { types, regions, nodes, comments, media };
}

async function base64ToBlob(data: string, mime: string): Promise<Blob> {
  const res = await fetch(`data:${mime};base64,${data}`);
  return res.blob();
}

export interface ImportResult {
  types: number;
  regions: number;
  nodes: number;
  comments: number;
  media: number;
}

/**
 * 导入 JSON。merge：按 id 合并（同 id 覆盖，不删除已有数据）；replace：清空后恢复为文件中的数据。
 */
export async function importJson(text: string, mode: 'merge' | 'replace'): Promise<ImportResult> {
  let data: Row;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(400, '文件不是有效的 JSON');
  }
  if (!data || data.app !== APP_ID) throw new ApiError(400, '不是本工具导出的数据文件');
  if (Number(data.version) > FORMAT_VERSION) throw new ApiError(400, '数据文件来自更新版本的工具，请先更新');
  const n = normalize(data);

  // 类型必须存在：合并时参考已有类型，替换时参考文件中的类型
  const existing = mode === 'merge' ? db.listTypes() : [];
  const typeIds = new Set([...existing.map((t) => t.id), ...n.types.map((t) => t.id)]);
  if (!typeIds.size) throw new ApiError(400, '文件中没有任何类型');
  const fallbackType = n.types[0]?.id ?? existing[0].id;
  const regionIds = new Set([...(mode === 'merge' ? db.listRegions().map((r) => r.id) : []), ...n.regions.map((r) => r.id)]);
  for (const node of n.nodes) {
    if (!typeIds.has(node.typeId)) node.typeId = fallbackType;
    if (node.regionId && !regionIds.has(node.regionId)) node.regionId = null;
  }

  const mediaRecs: MediaRecord[] = [];
  for (const m of n.media) {
    try {
      const blob = await base64ToBlob(m.data, m.mime);
      mediaRecs.push({ id: m.id, blob, name: m.name, mime: m.mime, size: blob.size, createdAt: m.createdAt });
    } catch {
      /* 损坏的媒体条目跳过 */
    }
  }

  await db.bulkWrite(n, mode === 'replace', [{ store: 'media', clear: mode === 'replace', put: mediaRecs }]);
  if (mode === 'replace') await db.markSaved();
  return { types: n.types.length, regions: n.regions.length, nodes: n.nodes.length, comments: n.comments.length, media: mediaRecs.length };
}

/** 清空全部本地数据（恢复默认类型与国籍） */
export async function clearAll(): Promise<void> {
  await idb.write([
    { store: 'types', clear: true },
    { store: 'regions', clear: true },
    { store: 'nodes', clear: true },
    { store: 'comments', clear: true },
    { store: 'media', clear: true },
    { store: 'kv', del: ['seeded', 'fileHandle', 'changeSeq', 'savedSeq'] },
  ]);
  await db.reloadFromDisk();
}

/**
 * 数据接口：全部在浏览器本地完成（IndexedDB），不依赖服务端。
 * 保持与原 HTTP 接口相同的形状，界面代码无需关心数据存在哪里。
 */
import * as auto from './local/auto';
import * as db from './local/db';
import { seedDemo } from './local/demo';
import { displayUrl } from './local/images';
import { saveMedia } from './local/media';
import { detailSource, profileList, searchSource, sourceList } from './local/sources';
import { describeError } from './local/http';
import { ApiError } from './local/util';
import type { BoardId, Candidate, CandidateDetail, Profile, ProfileInfo, Region, SourceInfo, TLComment, TLNode, TLType, Upload } from './types';
import type { CommentWithNode } from './local/db';

export { ApiError };

export interface StateResponse {
  types: TLType[];
  regions: Region[];
  nodes: TLNode[];
}

export interface NodeInput {
  typeId?: string;
  regionId?: string | null;
  title?: string;
  label?: string;
  start?: string;
  end?: string | null;
  created?: string;
  summary?: string;
  board?: BoardId;
}

function mustNode(n: TLNode | null): TLNode {
  if (!n) throw new ApiError(404, '节点不存在');
  return n;
}

/** 联网请求的错误统一转成可读的中文提示 */
async function net<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError(502, describeError(err));
  }
}

export const api = {
  async state(): Promise<StateResponse> {
    await db.ready();
    return { types: db.listTypes(), regions: db.listRegions(), nodes: db.listNodes() };
  },
  async sources(): Promise<{ sources: SourceInfo[]; profiles: Record<Profile, ProfileInfo> }> {
    return { sources: sourceList(), profiles: profileList() };
  },

  createType: (t: Partial<TLType>) => db.createType(t),
  updateType: (id: string, t: Partial<TLType>) => db.updateType(id, t),
  async deleteType(id: string, moveTo?: string) {
    const moved = await db.deleteType(id, moveTo);
    return { ok: true as const, moved };
  },
  async reorderTypes(ids: string[]) {
    await db.reorder('types', ids);
    return { types: db.listTypes(), regions: db.listRegions() };
  },

  createRegion: (name: string) => db.createRegion(name),
  updateRegion: (id: string, name: string) => db.updateRegion(id, name),
  async deleteRegion(id: string) {
    await db.deleteRegion(id);
    return { ok: true as const };
  },
  async reorderRegions(ids: string[]) {
    await db.reorder('regions', ids);
    return { types: db.listTypes(), regions: db.listRegions() };
  },

  async createNode(input: NodeInput & { candidate?: Candidate | null; auto?: boolean }): Promise<TLNode> {
    const { candidate, auto: wantAuto, ...rest } = input;
    const node = await db.createNode(rest);
    const type = db.getType(node.typeId);
    if ((wantAuto !== false && type?.profile !== 'none') || candidate) {
      return mustNode(await auto.enqueueAuto(node.id, { candidate: candidate ?? null }));
    }
    return node;
  },
  updateNode: (id: string, input: NodeInput) => db.updateNode(id, input),
  async deleteNode(id: string) {
    await db.deleteNode(id);
    return { ok: true as const };
  },
  async autoMeta(id: string, opts: { cover?: boolean; summary?: boolean; force?: boolean } = {}): Promise<TLNode> {
    if (!db.getNode(id)) throw new ApiError(404, '节点不存在');
    const { cover = true, summary = true, force = true } = opts;
    return mustNode(await auto.enqueueAuto(id, { cover, summary, force }));
  },
  async autoMissing() {
    return { count: auto.autoMissing() };
  },
  applyCandidate: (id: string, candidate: Candidate, opts: { cover?: boolean; summary?: boolean }) =>
    auto.applyCandidate(id, candidate, { cover: !!opts.cover, summary: !!opts.summary }),
  coverFromUrl: (id: string, url: string) => {
    const u = url.trim();
    if (!u) return Promise.reject(new ApiError(400, '请提供图片地址'));
    return auto.setCoverFromUrl(id, u);
  },
  clearCover: (id: string) => auto.clearCover(id),
  uploadCover: (id: string, file: Blob) => auto.setCoverFromBlob(id, file),

  async comments(nodeId: string): Promise<TLComment[]> {
    await db.ready();
    return db.listComments(nodeId);
  },
  async allComments(): Promise<CommentWithNode[]> {
    await db.ready();
    return db.allComments();
  },
  createComment: (nodeId: string, body: string) => db.createComment(nodeId, body),
  updateComment: (id: string, body: string) => db.updateComment(id, body),
  async deleteComment(id: string) {
    await db.deleteComment(id);
    return { ok: true as const };
  },

  async search(source: string, q: string, profile: string, signal?: AbortSignal): Promise<{ results: Candidate[] }> {
    const query = q.trim().slice(0, 100);
    if (!query) return { results: [] };
    const results = await net(searchSource(source, query, profile, { ...auto.INTERACTIVE, signal }));
    return { results: results.slice(0, 40) };
  },
  detail: (source: string, id: string, title: string, signal?: AbortSignal): Promise<CandidateDetail> =>
    net(detailSource(source, id, title, { ...auto.INTERACTIVE, signal })),

  async demo() {
    await db.ready();
    return { count: await seedDemo() };
  },
};

/** 远程图片的显示地址：本地媒体与普通图片原样使用，有防盗链的图床在有代理时走代理 */
export function imgSrc(url: string | undefined | null): string {
  if (!url) return '';
  return displayUrl(url);
}

const MAX_UPLOAD = 1024 * 1024 * 1024;

/** 评论中的文件：保存到浏览器本地媒体库 */
export function uploadFile(file: File, onProgress?: (ratio: number) => void): { promise: Promise<Upload>; abort: () => void } {
  let aborted = false;
  const promise = (async () => {
    if (!file.size) throw new ApiError(400, '文件为空');
    if (file.size > MAX_UPLOAD) throw new ApiError(413, '文件过大（上限 1GB）');
    onProgress?.(0.1);
    const name = (file.name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
    const rec = await saveMedia(file, name, 'up');
    if (aborted) throw new ApiError(0, '上传已取消');
    onProgress?.(1);
    return { url: `media/${rec.id}`, name, mime: rec.mime, size: rec.size };
  })();
  return {
    promise,
    abort: () => {
      aborted = true;
    },
  };
}

/**
 * 自动获取封面与简介：按类型对应的数据源检索、打分、下载封面；带并发队列。
 */
import type { Candidate, TLNode } from '../types';
import * as db from './db';
import { describeError } from './http';
import { saveCoverBlob, saveCoverFromUrl } from './images';
import { deleteMedia } from './media';
import { PROFILES, detailSource, kindMatch, regionMatch, searchSource, sourceAvailable } from './sources';
import { ApiError, similarity } from './util';
import { titleKey } from '../lib/text';

/** 低于这个分数的候选不会被自动采用 */
const ACCEPT = 0.6;
/** 后台自动获取：限流站点最多排队 8 秒，超时就改用其他来源 */
const BACKGROUND = { maxWait: 8000 };
/** 用户手动操作：插队 */
export const INTERACTIVE = { priority: 'high' as const, maxWait: 20000 };

interface Ctx {
  profile: string;
  title: string;
  label: string;
  full: string;
  year: number;
  regionName: string;
}

type Scored = Candidate & { sim: number; score: number };

function contextOf(node: TLNode): Ctx {
  const type = db.getType(node.typeId);
  const region = node.regionId ? db.getRegion(node.regionId) : null;
  const profile = type && PROFILES[type.profile] ? type.profile : 'generic';
  return {
    profile,
    title: node.title,
    label: node.label,
    full: [node.title, node.label].filter(Boolean).join(' '),
    year: Number(String(node.start).slice(0, 4)) || 0,
    regionName: region?.name ?? '',
  };
}

const QUALIFIERS =
  /剧场版|劇場版|电影版|真人版|动画版|动画电影|续集|外传|番外|特别篇|总集篇|前篇|后篇|完结篇|最终季|OVA|OAD|第[一二三四五六七八九十\d]+[季部期章卷]|season\s*\d+|the\s*movie|end of the world/gi;

/** 候选标题里出现、但节点名称里没有的限定词（如节点是「第一季」，候选是「剧场版」） */
function qualifierMismatch(candTitle: string, ctx: Ctx): boolean {
  const node = titleKey(ctx.full);
  for (const m of String(candTitle).matchAll(QUALIFIERS)) {
    if (!node.includes(titleKey(m[0]))) return true;
  }
  return false;
}

export function scoreCandidate(c: Candidate, ctx: Ctx): { sim: number; score: number } {
  const names = [c.title, c.subtitle, ...(c.names ?? [])].filter((x): x is string => !!x);
  let sim = 0;
  for (const n of names) {
    sim = Math.max(sim, similarity(n, ctx.full));
    // 带副标题（如「第二季」）时，只匹配到主标题的候选略微降权
    if (ctx.label) sim = Math.max(sim, similarity(n, ctx.title) - 0.08);
  }
  let score = sim;
  if (qualifierMismatch(c.title, ctx)) score -= 0.15;
  // 豆瓣读书本身就是书籍库，对小说/漫画视为类型吻合
  const bookSource = c.source === 'douban_book' && (ctx.profile === 'novel' || ctx.profile === 'manga');
  const k = bookSource ? 1 : kindMatch(ctx.profile, c.kind);
  score += k > 0 ? 0.12 : k < 0 ? -0.25 : 0;
  if (ctx.year && c.year) {
    const dy = Math.abs(Number(c.year) - ctx.year);
    if (dy === 0) score += 0.06;
    else if (dy === 1) score += 0.03;
  }
  const r = regionMatch(ctx.regionName, c.region);
  score += r > 0 ? 0.06 : r < 0 ? -0.12 : 0;
  return { sim, score };
}

async function gather(query: string, ctx: Ctx, sourceIds: string[], errors: Record<string, string>): Promise<Scored[]> {
  const settled = await Promise.allSettled(sourceIds.map((id) => searchSource(id, query, ctx.profile, BACKGROUND)));
  const out: Candidate[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') out.push(...s.value.slice(0, 8).map((c) => ({ ...c })));
    else errors[sourceIds[i]] = describeError(s.reason);
  });
  // 豆瓣联想接口不带类型与地区；同名条目有多个时，给最像的两条补上，避免把真人版当成动画
  const douban = out
    .filter((c) => c.source === 'douban_movie')
    .map((c) => ({ c, sim: scoreCandidate(c, ctx).sim }))
    .filter((x) => x.sim >= ACCEPT)
    .sort((a, b) => b.sim - a.sim);
  if (douban.length > 1) {
    await Promise.allSettled(
      douban.slice(0, 2).map(async ({ c }) => {
        const d = await detailSource('douban_movie', c.id, c.title, BACKGROUND);
        Object.assign(c, { kind: d.kind || c.kind, region: d.region || c.region, year: c.year || d.year, info: d.info });
      }),
    );
  }
  return out.map((c) => ({ ...c, ...scoreCandidate(c, ctx) }));
}

function dedupe(cands: Scored[]): Scored[] {
  const map = new Map<string, Scored>();
  for (const c of cands) {
    const key = `${c.source}|${c.id}`;
    const prev = map.get(key);
    if (!prev || c.score > prev.score) map.set(key, c);
  }
  return [...map.values()];
}

function priorityBonus(list: string[], source: string): number {
  const i = list.indexOf(source);
  return i < 0 ? 0 : (list.length - i) * 0.02;
}

function cjkRatio(text: string): number {
  const t = String(text ?? '').slice(0, 400).replace(/\s/g, '');
  if (!t) return 1;
  return (t.match(/[\u4e00-\u9fff]/g) ?? []).length / t.length;
}

async function candidateSummary(c: Candidate, opts: { priority?: 'high' | 'normal'; maxWait?: number } = BACKGROUND): Promise<string> {
  if (c.summary) return c.summary;
  if (!c.hasDetail) return '';
  const d = await detailSource(c.source, c.id, c.title, opts);
  return d.summary ?? '';
}

async function downloadCover(nodeId: string, c: Candidate) {
  const urls = [...new Set([c.coverLarge, c.cover, c.coverFallback].filter((x): x is string => !!x))];
  let lastErr: unknown = new Error('没有可用的封面地址');
  for (const u of urls) {
    try {
      const saved = await saveCoverFromUrl(nodeId, u);
      return { cover: saved.cover, coverThumb: saved.coverThumb, coverColor: saved.coverColor, coverSource: c.source, coverUrl: u };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export interface AutoOpts {
  cover?: boolean;
  summary?: boolean;
  force?: boolean;
  candidate?: Candidate | null;
}

export async function runAutoMeta(nodeId: string, opts: AutoOpts = {}): Promise<TLNode | null> {
  const node = db.getNode(nodeId);
  if (!node) return null;
  const ctx = contextOf(node);
  const profile = PROFILES[ctx.profile as keyof typeof PROFILES];
  const searchList = profile.search.filter(sourceAvailable);
  const wantCover = opts.cover !== false && (!!opts.force || !node.cover);
  const wantSummary = opts.summary !== false && (!!opts.force || !node.summary);
  const errors: Record<string, string> = {};
  const notes: string[] = [];
  let coverPatch: Awaited<ReturnType<typeof downloadCover>> | null = null;
  let summaryPatch: { summary: string; summarySource: string; summaryUrl: string } | null = null;

  // 1) 添加节点时用户已经选定的条目
  const picked = opts.candidate;
  if (picked?.source) {
    if (wantCover) {
      try {
        coverPatch = await downloadCover(node.id, picked);
      } catch (err) {
        notes.push(`所选条目封面：${describeError(err)}`);
      }
    }
    if (wantSummary && !picked.imageOnly) {
      try {
        const text = await candidateSummary(picked);
        if (text) summaryPatch = { summary: text, summarySource: picked.source, summaryUrl: picked.url ?? '' };
      } catch (err) {
        notes.push(`所选条目简介：${describeError(err)}`);
      }
    }
  }

  // 2) 按类型对应的数据源搜索并打分
  const needCover = wantCover && !coverPatch;
  const needSummary = wantSummary && !summaryPatch;
  if ((needCover || needSummary) && searchList.length) {
    const queries = [...new Set([ctx.full, ctx.title])];
    const batches = await Promise.all(queries.map((q) => gather(q, ctx, searchList, errors)));
    const cands = dedupe(batches.flat());

    if (needCover) {
      const pool = cands
        .filter((c) => (c.cover || c.coverLarge) && c.score >= ACCEPT)
        .map((c) => ({ c, rank: c.score + priorityBonus(profile.cover, c.source) }))
        .sort((a, b) => b.rank - a.rank);
      for (const { c } of pool.slice(0, 4)) {
        try {
          coverPatch = await downloadCover(node.id, c);
          break;
        } catch (err) {
          notes.push(`${c.source} 封面：${describeError(err)}`);
        }
      }
    }

    if (needSummary) {
      const pool = cands
        .filter((c) => profile.summary.includes(c.source) && c.score >= ACCEPT && (c.summary || c.hasDetail))
        .map((c) => ({
          c,
          // 偏好中文简介：英文简介（如 AniList）只在没有更好的中文条目时使用
          rank: c.score + priorityBonus(profile.summary, c.source) - (c.summary && cjkRatio(c.summary) < 0.2 ? 0.3 : 0),
        }))
        .sort((a, b) => b.rank - a.rank);
      for (const { c } of pool.slice(0, 4)) {
        try {
          const text = await candidateSummary(c);
          if (text) {
            summaryPatch = { summary: text, summarySource: c.source, summaryUrl: c.url ?? '' };
            break;
          }
        } catch (err) {
          notes.push(`${c.source} 简介：${describeError(err)}`);
        }
      }
    }
  }

  // 3) 结构化来源都没有封面时，用图片搜索兜底（需要跨域代理）
  if (wantCover && !coverPatch && ctx.profile !== 'none' && sourceAvailable('bing')) {
    try {
      const imgs = await searchSource('bing', `${ctx.full} ${profile.image}`.trim(), ctx.profile);
      const portrait = imgs.filter((i) => (i.height ?? 0) > (i.width ?? 0) * 1.15);
      for (const c of (portrait.length >= 2 ? portrait : imgs).slice(0, 4)) {
        try {
          coverPatch = await downloadCover(node.id, c);
          break;
        } catch (err) {
          notes.push(`图片搜索封面：${describeError(err)}`);
        }
      }
    } catch (err) {
      errors.bing = describeError(err);
    }
  }

  // 重新读取节点：获取期间用户可能已手动修改过封面或简介
  const latest = db.getNode(nodeId);
  if (!latest) {
    if (coverPatch) await deleteMedia([coverPatch.cover, coverPatch.coverThumb]);
    return null;
  }
  const patch: db.InternalPatch = {};
  if (coverPatch) {
    if (opts.force || !latest.cover) Object.assign(patch, coverPatch);
    else await deleteMedia([coverPatch.cover, coverPatch.coverThumb]);
  }
  if (summaryPatch && (opts.force || !latest.summary)) Object.assign(patch, summaryPatch);
  const gotCover = !wantCover || !!coverPatch;
  const gotSummary = !wantSummary || !!summaryPatch;
  patch.metaStatus = gotCover && gotSummary ? 'done' : coverPatch || summaryPatch ? 'partial' : 'failed';
  if (!searchList.length && !coverPatch && !summaryPatch) notes.push('当前环境下该类型没有可用的数据源');
  patch.meta = { ...latest.meta, auto: { at: Date.now(), errors, notes: notes.slice(0, 8) } };
  const updated = await db.updateNodeInternal(nodeId, patch);
  if (patch.cover && latest.cover && latest.cover !== patch.cover) await deleteMedia([latest.cover, latest.coverThumb]);
  return updated;
}

/* ------------------------------ 任务队列 ------------------------------ */

const queue: string[] = [];
const queued = new Map<string, AutoOpts>();
let active = 0;
const CONCURRENCY = 2;

function mergeOpts(a: AutoOpts, b: AutoOpts): AutoOpts {
  return {
    cover: a.cover !== false || b.cover !== false,
    summary: a.summary !== false || b.summary !== false,
    force: !!(a.force || b.force),
    candidate: b.candidate || a.candidate,
  };
}

export async function enqueueAuto(nodeId: string, opts: AutoOpts = {}): Promise<TLNode | null> {
  if (queued.has(nodeId)) {
    queued.set(nodeId, mergeOpts(queued.get(nodeId)!, opts));
    return db.getNode(nodeId);
  }
  queued.set(nodeId, opts);
  queue.push(nodeId);
  const node = await db.updateNodeInternal(nodeId, { metaStatus: 'pending' });
  pump();
  return node;
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const id = queue.shift()!;
    const opts = queued.get(id) ?? {};
    queued.delete(id);
    active++;
    runAutoMeta(id, opts)
      .catch(async (err) => {
        console.error('[auto] 自动获取失败', id, err);
        await db.updateNodeInternal(id, { metaStatus: 'failed' }).catch(() => {});
      })
      .finally(() => {
        active--;
        pump();
      });
  }
}

/** 页面关闭时尚未完成的任务：重新排队 */
export function resumePending(): void {
  for (const n of db.listNodes()) if (n.metaStatus === 'pending' && !queued.has(n.id)) void enqueueAuto(n.id, {});
}

export function autoMissing(): number {
  let count = 0;
  for (const n of db.listNodes()) {
    if (db.getType(n.typeId)?.profile === 'none') continue;
    if (n.metaStatus === 'pending' || (n.cover && n.summary)) continue;
    void enqueueAuto(n.id, {});
    count++;
  }
  return count;
}

/* --------------------------- 手动换源 / 上传 --------------------------- */

async function writeCover(node: TLNode, coverPatch: db.InternalPatch): Promise<TLNode> {
  const updated = await db.updateNodeInternal(node.id, { ...coverPatch, metaStatus: node.metaStatus === 'pending' ? 'pending' : 'done' });
  if (!updated) throw new ApiError(404, '节点不存在');
  if (node.cover && node.cover !== coverPatch.cover) await deleteMedia([node.cover, node.coverThumb]);
  return updated;
}

export async function applyCandidate(nodeId: string, candidate: Candidate, { cover = false, summary = false } = {}): Promise<TLNode> {
  const node = db.getNode(nodeId);
  if (!node) throw new ApiError(404, '节点不存在');
  if (!candidate?.source) throw new ApiError(400, '缺少候选条目');
  const patch: db.InternalPatch = {};
  if (cover) {
    try {
      Object.assign(patch, await downloadCover(nodeId, candidate));
    } catch (err) {
      throw new ApiError(502, `封面获取失败：${describeError(err)}`);
    }
  }
  if (summary && !candidate.imageOnly) {
    let text = '';
    try {
      text = await candidateSummary(candidate, INTERACTIVE);
    } catch (err) {
      if (!cover) throw new ApiError(502, `简介获取失败：${describeError(err)}`);
    }
    if (text) Object.assign(patch, { summary: text, summarySource: candidate.source, summaryUrl: candidate.url ?? '' });
    else if (!cover) throw new ApiError(404, '该条目没有可用的简介');
  }
  if (patch.cover) return writeCover(node, patch);
  const updated = await db.updateNodeInternal(nodeId, patch);
  if (!updated) throw new ApiError(404, '节点不存在');
  return updated;
}

export async function setCoverFromBlob(nodeId: string, blob: Blob): Promise<TLNode> {
  const node = db.getNode(nodeId);
  if (!node) throw new ApiError(404, '节点不存在');
  const saved = await saveCoverBlob(nodeId, blob);
  return writeCover(node, { ...saved, coverSource: 'upload', coverUrl: '' });
}

export async function setCoverFromUrl(nodeId: string, url: string): Promise<TLNode> {
  const node = db.getNode(nodeId);
  if (!node) throw new ApiError(404, '节点不存在');
  let saved;
  try {
    saved = await saveCoverFromUrl(nodeId, url);
  } catch (err) {
    throw new ApiError(502, `图片获取失败：${describeError(err)}`);
  }
  return writeCover(node, { cover: saved.cover, coverThumb: saved.coverThumb, coverColor: saved.coverColor, coverSource: 'link', coverUrl: url });
}

export async function clearCover(nodeId: string): Promise<TLNode> {
  const node = db.getNode(nodeId);
  if (!node) throw new ApiError(404, '节点不存在');
  const updated = await db.updateNodeInternal(nodeId, { cover: '', coverThumb: '', coverSource: '', coverUrl: '', coverColor: '' });
  await deleteMedia([node.cover, node.coverThumb]);
  return updated!;
}

import type { Candidate, CandidateDetail, Profile, ProfileInfo, SourceInfo } from '../types';
import { CodeError, hasProxy, jsonp, request } from './http';
import { clip, decodeEntities, stripHtml } from './util';

const enc = encodeURIComponent;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 每种「自动获取方式」对应的数据源顺序：
 *  search  —— 自动匹配时要查询的源
 *  cover   —— 选封面时的优先级
 *  summary —— 选简介时的优先级
 *  image   —— 结构化源都没有封面时，用图片搜索兜底的关键词后缀
 */
export const PROFILES: Record<Profile, ProfileInfo> = {
  anime: {
    label: '动画',
    search: ['bangumi', 'douban_movie', 'moegirl', 'baike', 'anilist', 'wikipedia'],
    cover: ['bangumi', 'douban_movie', 'anilist', 'moegirl', 'baike', 'wikipedia'],
    summary: ['bangumi', 'moegirl', 'baike', 'wikipedia', 'anilist'],
    image: '动画 海报',
  },
  manga: {
    label: '漫画',
    search: ['bangumi', 'douban_book', 'moegirl', 'baike', 'anilist', 'wikipedia'],
    cover: ['bangumi', 'douban_book', 'anilist', 'moegirl', 'baike', 'wikipedia'],
    summary: ['bangumi', 'moegirl', 'baike', 'douban_book', 'wikipedia', 'anilist'],
    image: '漫画 封面',
  },
  novel: {
    label: '小说',
    search: ['bangumi', 'douban_book', 'moegirl', 'baike', 'wikipedia', 'anilist'],
    cover: ['douban_book', 'bangumi', 'moegirl', 'baike', 'anilist', 'wikipedia'],
    summary: ['douban_book', 'bangumi', 'moegirl', 'baike', 'wikipedia'],
    image: '小说 封面',
  },
  movie: {
    label: '电影',
    search: ['douban_movie', 'baike', 'wikipedia'],
    cover: ['douban_movie', 'baike', 'wikipedia'],
    summary: ['baike', 'wikipedia'],
    image: '电影 海报',
  },
  tv: {
    label: '电视剧',
    search: ['douban_movie', 'baike', 'wikipedia'],
    cover: ['douban_movie', 'baike', 'wikipedia'],
    summary: ['baike', 'wikipedia'],
    image: '电视剧 海报',
  },
  generic: {
    label: '通用（百科）',
    search: ['baike', 'wikipedia'],
    cover: ['baike', 'wikipedia'],
    summary: ['baike', 'wikipedia'],
    image: '',
  },
  none: { label: '不自动获取', search: [], cover: [], summary: [], image: '' },
};

/* ------------------------------ 匹配辅助 ------------------------------ */

const KIND_TESTS: Partial<Record<Profile, RegExp>> = {
  anime: /动画|番剧|动漫|anime/i,
  manga: /漫画|manga|comic/i,
  novel: /小说|轻小说|novel/i,
  movie:
    /电影|影片|(?:科幻|动作|喜剧|爱情|剧情|恐怖|惊悚|战争|悬疑|动画|纪录|灾难|犯罪|奇幻|冒险|传记|歌舞|武侠|文艺|故事|青春|家庭|历史|运动|音乐|警匪|魔幻)片|movie|film/i,
  tv: /电视剧|网络剧|网剧|剧集|连续剧|美剧|日剧|韩剧|国产剧|科幻剧|古装剧|tv series|drama/i,
};

/** 1 = 类型吻合，-1 = 明确是别的类型，0 = 无法判断 */
export function kindMatch(profile: string, text: string | undefined): number {
  const re = KIND_TESTS[profile as Profile];
  if (!text || !re) return 0;
  if (re.test(text)) return 1;
  for (const [key, other] of Object.entries(KIND_TESTS)) if (key !== profile && other!.test(text)) return -1;
  return 0;
}

const REGION_ALIASES: Record<string, string[]> = {
  国产: ['中国大陆', '中国', '大陆', '内地', 'cn', '国产'],
  中国: ['中国大陆', '中国', '大陆', '内地', 'cn'],
  日本: ['日本', 'jp', 'japan'],
  美国: ['美国', 'us', 'usa', 'united states'],
  韩国: ['韩国', 'kr', 'south korea', '大韩民国'],
  英国: ['英国', 'gb', 'uk', 'united kingdom'],
  台湾: ['中国台湾', '台湾', 'tw'],
  香港: ['中国香港', '香港', 'hk'],
};

export function regionMatch(regionName: string, candidateRegion: string | undefined): number {
  if (!regionName || !candidateRegion) return 0;
  const aliases = REGION_ALIASES[regionName] ?? [regionName.toLowerCase()];
  const parts = String(candidateRegion)
    .toLowerCase()
    .split(/[\s/,，、]+/)
    .filter(Boolean);
  return parts.some((p) => aliases.includes(p)) ? 1 : -1;
}

const REGION_WORDS = ['中国大陆', '中国台湾', '中国香港', '美国', '日本', '韩国', '英国', '法国', '德国', '意大利', '西班牙', '印度', '泰国', '俄罗斯', '加拿大', '澳大利亚', '台湾', '香港', '中国', '国产'];

/** 从一句描述里找出最早出现的国家/地区名（如「日本2009年连载的漫画」→ 日本） */
export function regionFromText(text: string | undefined): string {
  const s = String(text ?? '');
  let best = '';
  let at = Infinity;
  for (const w of REGION_WORDS) {
    const i = s.indexOf(w);
    if (i >= 0 && i < at) {
      at = i;
      best = w;
    }
  }
  if (best === '国产' || best === '中国') return '中国大陆';
  return best;
}

const yearIn = (s: string | undefined) => (String(s ?? '').match(/((?:1[89]|20)\d{2})年/) ?? [])[1] ?? '';

/* ------------------------------ 数据源 ------------------------------ */

export interface SearchCtx {
  profile: string;
  signal?: AbortSignal;
  priority?: 'high' | 'normal';
  maxWait?: number;
}

export interface DetailCtx {
  title?: string;
  signal?: AbortSignal;
  priority?: 'high' | 'normal';
  maxWait?: number;
}

interface Source {
  id: string;
  name: string;
  summary: boolean;
  imageOnly?: boolean;
  /** 没有跨域代理就无法使用 */
  needsProxy?: boolean;
  search(q: string, ctx: SearchCtx): Promise<Candidate[]>;
  detail?(id: string, ctx: DetailCtx): Promise<CandidateDetail>;
}

function doubanLarge(u: string | undefined): string {
  return u
    ? u
        .replace('/s_ratio_poster/', '/l_ratio_poster/')
        .replace('/m_ratio_poster/', '/l_ratio_poster/')
        .replace('/view/photo/s/', '/view/photo/l/')
        .replace('/view/subject/s/', '/view/subject/l/')
        .replace('/view/subject/m/', '/view/subject/l/')
    : '';
}

interface BangumiSubject {
  id: number;
  type: number;
  name: string;
  name_cn: string;
  date?: string;
  platform?: string;
  summary?: string;
  image?: string;
  images?: { large?: string; common?: string; medium?: string };
  infobox?: { key: string; value: string | { v?: string }[] }[];
}

const bangumi: Source = {
  id: 'bangumi',
  name: 'Bangumi',
  summary: true,
  async search(q, { profile, signal }) {
    const types = ({ anime: [2], manga: [1], novel: [1], movie: [2, 6], tv: [6, 2] } as Record<string, number[]>)[profile];
    const j = await request<{ data?: BangumiSubject[] }>('https://api.bgm.tv/v0/search/subjects?limit=12', {
      method: 'POST',
      timeout: 8000,
      signal,
      proxy: 'fallback',
      body: JSON.stringify({ keyword: q, sort: 'match', filter: types ? { type: types } : {} }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    return (j.data ?? []).map((s) => {
      const aliases: string[] = [];
      for (const it of Array.isArray(s.infobox) ? s.infobox : []) {
        if (it.key !== '别名' && it.key !== '中文名') continue;
        if (typeof it.value === 'string') aliases.push(it.value);
        else if (Array.isArray(it.value)) for (const v of it.value) if (v?.v) aliases.push(v.v);
      }
      const typeName = ({ 1: '书籍', 2: '动画', 3: '音乐', 4: '游戏', 6: '三次元' } as Record<number, string>)[s.type] ?? '';
      return {
        source: 'bangumi',
        id: String(s.id),
        title: s.name_cn || s.name,
        subtitle: s.name_cn && s.name !== s.name_cn ? s.name : '',
        names: [s.name, s.name_cn, ...aliases].filter(Boolean),
        date: s.date ?? '',
        year: (s.date ?? '').slice(0, 4),
        cover: s.images?.common || s.images?.medium || s.image || '',
        coverLarge: s.images?.large || s.image || '',
        summary: clip(s.summary),
        url: `https://bgm.tv/subject/${s.id}`,
        kind: [typeName, s.platform].filter(Boolean).join(' · '),
      };
    });
  },
};

/* 豆瓣：被限流时联想接口会静默返回 []，连续出现空结果就暂停一会儿，让自动获取尽快改用其他来源 */
const douban = { empties: 0, coolUntil: 0 };

function doubanGuard() {
  const left = douban.coolUntil - Date.now();
  if (left > 0) throw new CodeError('THROTTLED', `豆瓣请求过于频繁，约 ${Math.ceil(left / 1000)} 秒后恢复`);
}

function doubanCheck<T>(arr: T[] | unknown): T[] {
  if (Array.isArray(arr) && arr.length > 0) {
    douban.empties = 0;
    return arr as T[];
  }
  douban.empties++;
  if (douban.empties >= 3) {
    douban.empties = 0;
    douban.coolUntil = Date.now() + 180_000;
  }
  throw new CodeError('EMPTY', '豆瓣没有返回结果（也可能是暂时限流）');
}

interface DoubanSuggest {
  id: string;
  type: string;
  title: string;
  sub_title?: string;
  year?: string;
  img?: string;
  pic?: string;
  url?: string;
  episode?: string;
  author_name?: string;
}

interface DoubanAbstract {
  is_tv?: boolean;
  types?: string[];
  region?: string;
  release_year?: string;
  directors?: string[];
  actors?: string[];
  episodes_count?: string;
  duration?: string;
  rate?: string;
}

const doubanMovie: Source = {
  id: 'douban_movie',
  name: '豆瓣电影',
  summary: false,
  needsProxy: true,
  async search(q, { signal, priority, maxWait }) {
    doubanGuard();
    const arr = doubanCheck<DoubanSuggest>(
      await request(`https://movie.douban.com/j/subject_suggest?q=${enc(q)}`, { timeout: 7000, signal, priority, maxWait, proxy: 'always' }),
    );
    return arr
      .filter((x) => x.type === 'movie')
      .map((x) => ({
        source: 'douban_movie',
        id: String(x.id),
        title: x.title,
        subtitle: x.sub_title && x.sub_title !== x.title ? x.sub_title : '',
        names: [x.title, x.sub_title].filter((v): v is string => !!v),
        year: x.year ?? '',
        cover: x.img ?? '',
        coverLarge: doubanLarge(x.img),
        url: String(x.url ?? '').split('?')[0],
        kind: x.episode ? `剧集 · ${x.episode} 集` : '',
        hasDetail: true,
      }));
  },
  async detail(id, { signal, priority, maxWait }) {
    doubanGuard();
    const j = await request<{ subject?: DoubanAbstract }>(`https://movie.douban.com/j/subject_abstract?subject_id=${enc(id)}`, {
      timeout: 7000,
      signal,
      priority,
      maxWait,
      proxy: 'always',
    });
    const s: DoubanAbstract = j.subject ?? {};
    return {
      kind: [s.is_tv ? '剧集' : '电影', ...(s.types ?? [])].join(' · '),
      region: s.region ?? '',
      year: s.release_year ?? '',
      info: [
        s.region && `地区：${s.region}`,
        s.directors?.length && `导演：${s.directors.slice(0, 3).join(' / ')}`,
        s.actors?.length && `主演：${s.actors.slice(0, 5).join(' / ')}`,
        s.episodes_count && `集数：${s.episodes_count}`,
        s.duration && `片长：${s.duration}`,
        s.rate && `豆瓣评分：${s.rate}`,
      ].filter((x): x is string => !!x),
      summary: '',
    };
  },
};

const doubanBook: Source = {
  id: 'douban_book',
  name: '豆瓣读书',
  summary: true,
  needsProxy: true,
  async search(q, { signal, priority, maxWait }) {
    doubanGuard();
    const arr = doubanCheck<DoubanSuggest>(
      await request(`https://book.douban.com/j/subject_suggest?q=${enc(q)}`, { timeout: 7000, signal, priority, maxWait, proxy: 'always' }),
    );
    return arr
      .filter((x) => x.type === 'b')
      .map((x) => ({
        source: 'douban_book',
        id: String(x.id),
        title: x.title,
        subtitle: x.author_name ?? '',
        names: [x.title],
        year: x.year ?? '',
        cover: x.pic ?? '',
        coverLarge: doubanLarge(x.pic),
        url: String(x.url ?? '').split('?')[0],
        kind: '图书',
        hasDetail: true,
      }));
  },
  async detail(id, { signal, priority, maxWait }) {
    doubanGuard();
    const j = await request<{
      intro?: string; pic?: { large?: string }; cover_url?: string; pubdate?: string | string[];
      author?: string[]; press?: string[]; rating?: { value?: number };
    }>(`https://m.douban.com/rexxar/api/v2/book/${enc(id)}`, { timeout: 8000, signal, priority, maxWait, proxy: 'always' });
    const pub = Array.isArray(j.pubdate) ? j.pubdate[0] : j.pubdate;
    return {
      summary: clip(j.intro),
      coverLarge: j.pic?.large || j.cover_url || '',
      year: String(pub ?? '').slice(0, 4),
      info: [
        j.author?.length && `作者：${j.author.join(' / ')}`,
        j.press?.length && `出版社：${j.press.join(' / ')}`,
        pub && `出版：${pub}`,
        j.rating?.value && `豆瓣评分：${j.rating.value}`,
      ].filter((x): x is string => !!x),
    };
  },
};

const ANILIST_FORMAT: Record<string, string> = {
  TV: 'TV',
  TV_SHORT: 'TV 短篇',
  MOVIE: '剧场版',
  SPECIAL: '特别篇',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'MV',
  MANGA: '漫画',
  NOVEL: '小说',
  ONE_SHOT: '短篇漫画',
};

interface AniMedia {
  id: number;
  type: string;
  format: string;
  title: { native?: string; romaji?: string; english?: string };
  synonyms?: string[];
  startDate?: { year?: number; month?: number; day?: number };
  coverImage?: { extraLarge?: string; large?: string; medium?: string };
  description?: string;
  siteUrl?: string;
  countryOfOrigin?: string;
}

const anilist: Source = {
  id: 'anilist',
  name: 'AniList',
  summary: true,
  async search(q, { profile, signal }) {
    const filter =
      ({
        anime: ', type: ANIME',
        movie: ', type: ANIME, format: MOVIE',
        manga: ', type: MANGA, format_not: NOVEL',
        novel: ', type: MANGA, format: NOVEL',
      } as Record<string, string>)[profile] ?? '';
    const query = `query($s:String){Page(perPage:12){media(search:$s${filter}, sort: SEARCH_MATCH){id type format title{native romaji english} synonyms startDate{year month day} coverImage{extraLarge large medium} description(asHtml:false) siteUrl countryOfOrigin}}}`;
    const j = await request<{ data?: { Page?: { media?: AniMedia[] } } }>('https://graphql.anilist.co', {
      method: 'POST',
      timeout: 9000,
      signal,
      proxy: 'fallback',
      body: JSON.stringify({ query, variables: { s: q } }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    return (j.data?.Page?.media ?? []).map((m) => {
      const zh = (m.synonyms ?? []).find((s) => /[\u4e00-\u9fff]/.test(s) && !/[\u3040-\u30ff]/.test(s));
      const title = zh || m.title.native || m.title.romaji || m.title.english || '';
      const sd = m.startDate ?? {};
      const date = sd.year ? [sd.year, sd.month && pad(sd.month), sd.month && sd.day && pad(sd.day)].filter(Boolean).join('-') : '';
      const kind = m.type === 'ANIME' ? `动画 · ${ANILIST_FORMAT[m.format] ?? m.format ?? ''}` : (ANILIST_FORMAT[m.format] ?? '漫画');
      return {
        source: 'anilist',
        id: String(m.id),
        title,
        subtitle: [m.title.native, m.title.english || m.title.romaji].filter((x) => x && x !== title).join(' / '),
        names: [m.title.native, m.title.romaji, m.title.english, ...(m.synonyms ?? [])].filter((x): x is string => !!x),
        date,
        year: sd.year ? String(sd.year) : '',
        cover: m.coverImage?.large || m.coverImage?.medium || '',
        coverLarge: m.coverImage?.extraLarge || m.coverImage?.large || '',
        summary: clip(stripHtml(m.description).replace(/\(Source:[^)]*\)/gi, '').trim()),
        url: m.siteUrl ?? '',
        kind,
        region: m.countryOfOrigin ?? '',
      };
    });
  },
};

/* 百度百科：联想列表接口不支持跨域，没有代理时改用支持 JSONP 的词条卡片接口（只返回该名称的默认义项） */

interface BaikeCard {
  id?: number;
  newLemmaId?: number;
  key?: string;
  title?: string;
  desc?: string;
  image?: string;
  src?: string;
  abstract?: string;
}

function baikeCard(key: string, signal?: AbortSignal): Promise<BaikeCard> {
  return jsonp<BaikeCard>(
    `https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=${enc(key)}&bk_length=2400`,
    { signal, timeout: 8000 },
  );
}

/** 百度图床（bcebos）支持按参数缩放；原图常常是十几 MB 的 PNG */
function bceSized(url: string, w: number): string {
  if (!url) return '';
  if (!/\.bcebos\.com\//.test(url)) return url;
  return `${url.split('?')[0]}?x-bce-process=image/resize,m_lfit,w_${w},limit_1/format,f_jpg`;
}

function baikeCardCandidate(c: BaikeCard): Candidate | null {
  if (!c?.title || !(c.newLemmaId || c.id)) return null;
  const id = String(c.newLemmaId || c.id);
  const pic = c.src ? `https://bkimg.cdn.bcebos.com/pic/${c.src}` : String(c.image ?? '').split('?')[0];
  return {
    source: 'baike',
    id,
    title: c.title,
    subtitle: c.desc ?? '',
    names: [c.title, c.key ?? ''].filter(Boolean),
    year: yearIn(c.desc),
    // 原图往往很大：列表里用百度图床的缩放版本，保存封面时用原图
    cover: bceSized(pic, 360),
    coverLarge: bceSized(pic, 900),
    coverFallback: pic,
    summary: clip(c.abstract),
    url: `https://baike.baidu.com/item/${enc(c.title)}/${id}`,
    kind: c.desc ?? '',
    region: regionFromText(c.desc),
  };
}

interface BaikeSuggest {
  lemmaId: number;
  lemmaTitle: string;
  lemmaDesc?: string;
  abstractPic?: string;
}

const baike: Source = {
  id: 'baike',
  name: '百度百科',
  summary: true,
  async search(q, { signal }) {
    if (hasProxy()) {
      try {
        const j = await request<{ list?: BaikeSuggest[] }>(`https://baike.baidu.com/api/searchui/suggest?wd=${enc(q)}&enc=utf8`, {
          timeout: 7000,
          signal,
          proxy: 'always',
        });
        if (j.list?.length) {
          return j.list.map((x) => ({
            source: 'baike',
            id: String(x.lemmaId),
            title: x.lemmaTitle,
            subtitle: x.lemmaDesc ?? '',
            names: [x.lemmaTitle],
            year: yearIn(x.lemmaDesc),
            cover: x.abstractPic ?? '',
            coverLarge: bceSized(String(x.abstractPic ?? '').split('?')[0], 900),
            coverFallback: String(x.abstractPic ?? '').split('?')[0],
            url: `https://baike.baidu.com/item/${enc(x.lemmaTitle)}/${x.lemmaId}`,
            kind: x.lemmaDesc ?? '',
            region: regionFromText(x.lemmaDesc),
            hasDetail: true,
          }));
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        /* 退回卡片接口 */
      }
    }
    const c = baikeCardCandidate(await baikeCard(q, signal));
    return c ? [c] : [];
  },
  async detail(id, { title, signal }) {
    if (hasProxy()) {
      try {
        const html = await request<string>(`https://wapbaike.baidu.com/item/${enc(title || '_')}/${enc(id)}`, {
          timeout: 10000,
          signal,
          parse: 'text',
          proxy: 'always',
        });
        const out = parseBaikePage(html);
        if (out.summary) return out;
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }
    if (!title) return {};
    const c = baikeCardCandidate(await baikeCard(title, signal));
    if (!c) return {};
    return { summary: c.summary, coverLarge: c.coverLarge, kind: c.kind };
  },
};

function parseBaikePage(html: string): CandidateDetail {
  const out: CandidateDetail = { summary: '' };
  const next = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (next) {
    try {
      const pd = JSON.parse(next[1])?.props?.pageProps?.pageData ?? {};
      const paragraphs = (Array.isArray(pd.abstract) ? pd.abstract : [])
        .map((p: { content?: { text?: string }[] }) => (Array.isArray(p.content) ? p.content.map((c) => c.text ?? '').join('') : ''))
        .map((s: string) => s.trim())
        .filter(Boolean);
      out.summary = clip(paragraphs.join('\n\n'));
      const pic = pd.abstractAlbum?.coverPic?.src || pd.albums?.[0]?.coverPic?.src;
      if (pic) out.coverLarge = `https://bkimg.cdn.bcebos.com/pic/${pic}`;
      if (pd.lemmaDesc) out.kind = pd.lemmaDesc;
    } catch {
      /* 页面结构变化时退回 meta 描述 */
    }
  }
  if (!out.summary) {
    const desc = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1];
    if (desc) out.summary = clip(decodeEntities(desc));
  }
  if (!out.coverLarge) {
    const og = html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i)?.[1];
    if (og) out.coverLarge = decodeEntities(og).split('?')[0];
  }
  return out;
}

function wikiKind(title: string, extract: string | undefined): string {
  const paren = String(title).match(/[（(]([^）)]+)[）)]\s*$/)?.[1] ?? '';
  const first = String(extract ?? '').split(/[。\n]/)[0] ?? '';
  return [paren, first.slice(0, 60)].filter(Boolean).join(' · ');
}

interface WikiPage {
  pageid: number;
  index?: number;
  title: string;
  varianttitles?: Record<string, string>;
  thumbnail?: { source?: string };
  extract?: string;
  fullurl?: string;
}

const wikipedia: Source = {
  id: 'wikipedia',
  name: '维基百科',
  summary: true,
  async search(q, { signal }) {
    const url =
      'https://zh.wikipedia.org/w/api.php?action=query&generator=search&gsrnamespace=0&gsrlimit=8' +
      `&gsrsearch=${enc(q)}` +
      '&prop=pageimages%7Cextracts%7Cinfo&exintro=1&explaintext=1&exlimit=max' +
      '&piprop=thumbnail&pithumbsize=640&pilicense=any&inprop=url%7Cvarianttitles' +
      '&format=json&formatversion=2&variant=zh-cn&uselang=zh-cn&origin=*';
    const j = await request<{ query?: { pages?: WikiPage[] } }>(url, { timeout: 10000, signal, proxy: 'fallback' });
    const pages = (j.query?.pages ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return pages.map((p) => {
      const title = p.varianttitles?.['zh-cn'] || p.title;
      const bare = title.replace(/\s*[（(][^）)]*[）)]\s*$/, '');
      const thumb = String(p.thumbnail?.source ?? '').split('?')[0];
      const kind = wikiKind(title, p.extract);
      return {
        source: 'wikipedia',
        id: String(p.pageid),
        title,
        names: [bare, p.title.replace(/\s*[（(][^）)]*[）)]\s*$/, '')],
        cover: thumb,
        coverLarge: thumb,
        summary: clip(p.extract),
        url: p.fullurl || `https://zh.wikipedia.org/wiki/${enc(p.title)}`,
        kind,
        region: regionFromText(kind),
        year: yearIn(p.extract),
      };
    });
  },
};

/** 萌娘百科：ACG 向中文百科，动画/漫画条目常比通用百科更全，且开放跨域接口 */
const moegirl: Source = {
  id: 'moegirl',
  name: '萌娘百科',
  summary: true,
  async search(q, { signal }) {
    const j = await request<{ query?: { search?: { pageid: number; title: string }[] } }>(
      `https://zh.moegirl.org.cn/api.php?action=query&list=search&srsearch=${enc(q)}&format=json&origin=*&srlimit=15`,
      { timeout: 10000, signal, proxy: 'fallback' },
    );
    return (j.query?.search ?? []).map((r) => ({
      source: 'moegirl',
      id: String(r.pageid),
      title: r.title,
      names: [r.title],
      url: `https://zh.moegirl.org.cn/${enc(r.title)}`,
    }));
  },
  async detail(_id, { title, signal }) {
    const j = await request<{ query?: { pages?: Record<string, { extract?: string }> } }>(
      `https://zh.moegirl.org.cn/api.php?action=query&prop=extracts&exintro&explaintext&titles=${enc(title ?? '')}&format=json&origin=*`,
      { timeout: 10000, signal, proxy: 'fallback' },
    );
    const txt = Object.values(j.query?.pages ?? {})[0]?.extract ?? '';
    return { summary: clip(stripHtml(txt).replace(/\(Source:[^)]*\)/gi, '').trim()) };
  },
};

function bingThumbLarge(turl: string | undefined): string {
  if (!turl || !/\/th\?id=/.test(turl)) return '';
  return `${turl.replace(/&pid=[^&]*/g, '')}&w=720&h=1080&rs=1&pid=ImgDetMain`;
}

const bing: Source = {
  id: 'bing',
  name: '必应图片',
  summary: false,
  imageOnly: true,
  needsProxy: true,
  async search(q, { signal }) {
    const html = await request<string>(`https://cn.bing.com/images/async?q=${enc(q)}&first=0&count=40&mmasync=1`, {
      timeout: 9000,
      signal,
      parse: 'text',
      proxy: 'always',
    });
    const out: Candidate[] = [];
    for (const m of html.matchAll(/<a\b[^>]*class="iusc"[^>]*>/g)) {
      const tag = m[0];
      const raw = tag.match(/\bm="([^"]*)"/)?.[1];
      if (!raw) continue;
      let o: { murl?: string; turl?: string; purl?: string; t?: string; mid?: string; md5?: string };
      try {
        o = JSON.parse(decodeEntities(raw));
      } catch {
        continue;
      }
      if (!o.murl) continue;
      const style = tag.match(/style="([^"]*)"/)?.[1] ?? '';
      out.push({
        source: 'bing',
        id: o.mid || o.md5 || o.murl,
        title: stripHtml(o.t ?? ''),
        cover: o.turl || o.murl,
        coverLarge: o.murl,
        coverFallback: bingThumbLarge(o.turl),
        url: o.purl ?? '',
        imageOnly: true,
        width: Number(style.match(/width:\s*(\d+)/)?.[1]) || 0,
        height: Number(style.match(/height:\s*(\d+)/)?.[1]) || 0,
      });
    }
    return out;
  },
};

interface BaiduImg {
  di?: string;
  cs?: string;
  thumbURL?: string;
  middleURL?: string;
  fromPageTitleEnc?: string;
  fromPageTitle?: string;
  replaceUrl?: { ObjURL?: string; FromURL?: string }[];
  width?: number;
  height?: number;
}

const baiduImg: Source = {
  id: 'baidu_img',
  name: '百度图片',
  summary: false,
  imageOnly: true,
  needsProxy: true,
  async search(q, { signal }) {
    const text = await request<string>(
      `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ie=utf-8&oe=utf-8&fp=result&word=${enc(q)}&queryWord=${enc(q)}&pn=0&rn=30&nc=1`,
      { timeout: 9000, signal, parse: 'text', proxy: 'always' },
    );
    let j: { data?: BaiduImg[] };
    try {
      j = JSON.parse(text);
    } catch {
      j = JSON.parse(text.replace(/\\'/g, "'"));
    }
    return (j.data ?? [])
      .filter((x) => x && (x.thumbURL || x.middleURL))
      .map((x, i) => ({
        source: 'baidu_img',
        id: String(x.di || x.cs || i),
        title: stripHtml(x.fromPageTitleEnc || x.fromPageTitle || ''),
        cover: x.middleURL || x.thumbURL,
        coverLarge: x.replaceUrl?.[0]?.ObjURL || x.middleURL || x.thumbURL,
        coverFallback: x.middleURL || x.thumbURL,
        url: x.replaceUrl?.[0]?.FromURL ?? '',
        imageOnly: true,
        width: Number(x.width) || 0,
        height: Number(x.height) || 0,
      }));
  },
};

export const SOURCES: Record<string, Source> = {
  bangumi,
  douban_movie: doubanMovie,
  douban_book: doubanBook,
  anilist,
  baike,
  wikipedia,
  moegirl,
  bing,
  baidu_img: baiduImg,
};

export function sourceAvailable(id: string): boolean {
  const s = SOURCES[id];
  return !!s && (!s.needsProxy || hasProxy());
}

export function sourceList(): SourceInfo[] {
  return Object.values(SOURCES).map((s) => ({
    id: s.id,
    name: s.name,
    imageOnly: !!s.imageOnly,
    summary: !!s.summary,
    available: sourceAvailable(s.id),
    note: s.needsProxy && !hasProxy() ? '该网站不允许浏览器跨域访问，需要配置跨域代理（设置 → 数据）' : '',
  }));
}

/** 各自动获取方式的来源顺序（已去掉当前不可用的来源） */
export function profileList(): Record<Profile, ProfileInfo> {
  const out = {} as Record<Profile, ProfileInfo>;
  for (const [k, p] of Object.entries(PROFILES) as [Profile, ProfileInfo][]) {
    out[k] = {
      ...p,
      search: p.search.filter(sourceAvailable),
      cover: p.cover.filter(sourceAvailable),
      summary: p.summary.filter(sourceAvailable),
    };
  }
  return out;
}

/* ---------------------- 带缓存与并发去重的查询 ---------------------- */

const CACHE_TTL = 10 * 60 * 1000;
const searchCache = new Map<string, { at: number; promise: Promise<Candidate[]> }>();
const detailCache = new Map<string, { at: number; promise: Promise<CandidateDetail> }>();

export function searchSource(
  sourceId: string,
  q: string,
  profile = 'generic',
  opts: { priority?: 'high' | 'normal'; maxWait?: number; signal?: AbortSignal } = {},
): Promise<Candidate[]> {
  const src = SOURCES[sourceId];
  if (!src) return Promise.reject(new Error(`未知来源：${sourceId}`));
  if (!sourceAvailable(sourceId)) return Promise.reject(new CodeError('NO_PROXY', '需要跨域代理（见 设置 → 数据）'));
  const key = `${sourceId}|${profile}|${q}|${hasProxy() ? 1 : 0}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.promise;
  // 共享的请求不绑定调用方的取消信号；调用方取消时只是不再等待
  const promise = src.search(q, { profile, priority: opts.priority, maxWait: opts.maxWait });
  searchCache.set(key, { at: Date.now(), promise });
  promise.then(
    (r) => {
      if (!r?.length) searchCache.delete(key);
    },
    () => searchCache.delete(key),
  );
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value as string);
  return withSignal(promise, opts.signal);
}

export function detailSource(
  sourceId: string,
  id: string,
  title: string,
  opts: { priority?: 'high' | 'normal'; maxWait?: number; signal?: AbortSignal } = {},
): Promise<CandidateDetail> {
  const src = SOURCES[sourceId];
  if (!src?.detail) return Promise.resolve({});
  const key = `${sourceId}|${id}|${hasProxy() ? 1 : 0}`;
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return withSignal(hit.promise, opts.signal);
  const promise = src.detail(id, { title, priority: opts.priority, maxWait: opts.maxWait });
  detailCache.set(key, { at: Date.now(), promise });
  promise.catch(() => detailCache.delete(key));
  if (detailCache.size > 500) detailCache.delete(detailCache.keys().next().value as string);
  return withSignal(promise, opts.signal);
}

function withSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

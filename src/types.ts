export type Profile = 'anime' | 'manga' | 'novel' | 'movie' | 'tv' | 'generic' | 'none';

/** 看板：main = 正式时光轴（填观看/经历时间），watch = 备选观看（只填一个记录时间） */
export type BoardId = 'main' | 'watch';

export interface TLType {
  id: string;
  name: string;
  color: string;
  icon: string;
  profile: Profile;
  sort: number;
}

export interface Region {
  id: string;
  name: string;
  sort: number;
}

export type MetaStatus = 'idle' | 'pending' | 'done' | 'partial' | 'failed';

export interface AutoInfo {
  at: number;
  errors: Record<string, string>;
  notes: string[];
}

export interface TLNode {
  id: string;
  typeId: string;
  regionId: string | null;
  /** 所在看板；缺省视为 main（正式时光轴） */
  board?: BoardId;
  title: string;
  label: string;
  start: string;
  end: string | null;
  /** 作品本身的创作/出版年份（区别于节点记录的事件时间，如重看、连载） */
  created?: string;
  summary: string;
  summarySource: string;
  summaryUrl: string;
  cover: string;
  coverThumb: string;
  coverSource: string;
  coverUrl: string;
  coverColor: string;
  metaStatus: MetaStatus;
  meta: { auto?: AutoInfo } & Record<string, unknown>;
  commentCount: number;
  commentText: string;
  createdAt: number;
  updatedAt: number;
}

export interface TLComment {
  id: string;
  nodeId: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface Candidate {
  source: string;
  id: string;
  title: string;
  subtitle?: string;
  names?: string[];
  year?: string;
  date?: string;
  cover?: string;
  coverLarge?: string;
  coverFallback?: string;
  summary?: string;
  hasDetail?: boolean;
  url?: string;
  kind?: string;
  region?: string;
  width?: number;
  height?: number;
  imageOnly?: boolean;
  info?: string[];
}

export interface CandidateDetail {
  summary?: string;
  coverLarge?: string;
  kind?: string;
  region?: string;
  year?: string;
  info?: string[];
}

export interface SourceInfo {
  id: string;
  name: string;
  imageOnly: boolean;
  summary: boolean;
  /** 当前环境下能否使用（部分网站需要跨域代理） */
  available: boolean;
  note: string;
}

export interface ProfileInfo {
  label: string;
  search: string[];
  cover: string[];
  summary: string[];
  image: string;
}

export interface Upload {
  url: string;
  name: string;
  mime: string;
  size: number;
}

/** 当前「点亮」的范围 */
export type Scope =
  | { kind: 'none' }
  | { kind: 'title'; key: string; title: string }
  | {
      kind: 'filter';
      /** typeId -> 国籍 id 列表（'_' 表示未设置国籍）；null 表示该类型全部 */
      sel: Record<string, string[] | null>;
      /** click = 点击节点产生；bar = 顶部类型筛选产生 */
      origin: 'click' | 'bar';
    };

export type Relation = 'title' | 'type' | 'subtype';
export type Density = 'auto' | 'poster' | 'card' | 'chip' | 'dot';

/** 时间轴方向：h = 横向（时间从左到右），v = 纵向（时间从上到下） */
export type Orientation = 'h' | 'v';

export interface NodeDraft {
  typeId: string;
  regionId: string | null;
  title: string;
  label: string;
  start: string;
  end: string | null;
  created?: string;
  summary: string;
  board?: BoardId;
}

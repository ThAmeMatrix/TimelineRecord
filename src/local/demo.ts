import * as db from './db';
import { enqueueAuto } from './auto';

const SAMPLE_COMMENT = `## 第一季看完了

**震撼。** OP 一响就停不下来，*自由之翼* 循环了一整天。

- [x] 第一季
- [x] 第二季
- [ ] 最终季

> 「这个世界是残酷的，但也是美丽的。」

| 季 | 个人评分 |
| --- | --- |
| 第一季 | 9.5 |
| 第二季 | 9.0 |

\`\`\`text
评论支持 Markdown：标题、列表、任务、引用、表格、代码，
也可以直接粘贴 / 拖入图片、视频和音频。
\`\`\`
`;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type Sample = [profile: string, region: string | null, title: string, label: string, start: string, end: string | null, summary?: string];

const SAMPLES: Sample[] = [
  ['manga', 'jp', '进击的巨人', '', '2009-09', '2021-04'],
  ['anime', 'jp', '进击的巨人', '第一季', '2013-04-07', '2013-09-28'],
  ['anime', 'jp', '进击的巨人', '第二季', '2017-04-01', '2017-06-17'],
  ['movie', 'jp', '进击的巨人', '真人版', '2015-08-01', null],
  ['novel', 'cn', '三体', '', '2008-01', null],
  ['anime', 'cn', '三体', '', '2022-12-10', '2023-03-18'],
  ['tv', 'cn', '三体', '', '2023-01-15', '2023-02-03'],
  ['tv', 'us', '三体', '', '2024-03-21', null],
  ['movie', 'cn', '流浪地球', '', '2019-02-05', null],
  ['movie', 'cn', '流浪地球2', '', '2023-01-22', null],
  ['novel', 'cn', '琅琊榜', '', '2007', null],
  ['tv', 'cn', '琅琊榜', '', '2015-09-19', '2015-10-15'],
  ['novel', 'cn', '庆余年', '', '2007-05', null],
  ['tv', 'cn', '庆余年', '', '2019-11-26', '2019-12-24'],
  ['manga', 'jp', '葬送的芙莉莲', '', '2020-04-28', null],
  ['anime', 'jp', '葬送的芙莉莲', '', '2023-09-29', '2024-03-22'],
  ['manga', 'jp', '鬼灭之刃', '', '2016-02-15', '2020-05-18'],
  ['anime', 'jp', '鬼灭之刃', '', '2019-04-06', '2019-09-28'],
  ['anime', 'jp', '你的名字。', '', '2016-08-26', null],
  ['movie', 'us', '星际穿越', '', '2014-11-07', null],
  ['movie', 'kr', '寄生虫', '', '2019-05-30', null],
  ['tv', 'kr', '请回答1988', '', '2015-11-06', '2016-01-16'],
  ['tv', 'kr', '鱿鱼游戏', '', '2021-09-17', null],
  ['novel', null, '哈利·波特与魔法石', '', '1997-06-26', null],
  ['movie', 'us', '哈利·波特与魔法石', '', '2001-11-16', null],
  ['none', null, '第一次去日本旅行', '', '2019-04-01', '2019-04-08', '东京 · 京都 · 大阪，七天六晚。'],
  ['none', null, '开始用时间轴做记录', '', today(), null, '把看过的、读过的、经历过的，都放到同一条时间轴上。'],
];

export async function seedDemo(): Promise<number> {
  const types = db.listTypes();
  const regions = db.listRegions();
  const typeFor = (profile: string) =>
    types.find((t) => t.id === (profile === 'none' ? 'daily' : profile)) ?? types.find((t) => t.profile === profile) ?? types[0];
  const regionFor = (id: string | null) => regions.find((r) => r.id === id)?.id ?? null;
  const created = [];
  for (const [profile, region, title, label, start, end, summary] of SAMPLES) {
    const type = typeFor(profile);
    const node = await db.createNode({
      typeId: type.id,
      regionId: regionFor(region),
      title,
      label,
      start,
      end,
      ...(summary ? { summary, summarySource: 'manual' } : {}),
    });
    created.push(node);
    if (type.profile !== 'none') void enqueueAuto(node.id, {});
  }
  const withComment = created.find((n) => n.title === '进击的巨人' && n.label === '第一季');
  if (withComment) await db.createComment(withComment.id, SAMPLE_COMMENT);
  return created.length;
}

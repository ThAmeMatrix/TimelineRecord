import { memo, type CSSProperties } from 'react';
import { formatShort } from '../lib/dates';
import type { Lod } from '../lib/layout';
import type { TLNode } from '../types';
import { CoverImg } from './Media';

export type ItemState = 'normal' | 'lit' | 'dim' | 'current';

interface Props {
  node: TLNode;
  lod: Lod;
  /** 距坐标原点的天数（时间轴上的位置由父组件按当前缩放直接写入 transform，缩放时不重渲染） */
  d: number;
  /** 沿列轴的位置（像素） */
  x: number;
  /** 时间段长度（天），0 表示单点 */
  rd: number;
  color: string;
  icon: string;
  typeName: string;
  regionName: string;
  state: ItemState;
}

export function Cover({ node, icon, className = '' }: { node: TLNode; icon: string; className?: string }) {
  const src = node.coverThumb || node.cover;
  return (
    <div
      className={`cv ${className} ${node.metaStatus === 'pending' && !src ? 'pending' : ''}`}
      style={node.coverColor ? { backgroundColor: node.coverColor } : undefined}
    >
      {src ? (
        <CoverImg
          key={src}
          src={src}
          alt=""
          draggable={false}
          decoding="async"
          loading="lazy"
          onLoad={(e) => e.currentTarget.classList.add('ok')}
        />
      ) : (
        <div className="cv-ph">
          <span className="cv-ph-icon">{icon}</span>
          <span className="cv-ph-title">{node.title}</span>
        </div>
      )}
    </div>
  );
}

function dateText(node: TLNode) {
  return node.end ? `${formatShort(node.start)} – ${formatShort(node.end)}` : formatShort(node.start);
}

export const TimelineItem = memo(function TimelineItem(props: Props) {
  const { node, lod, d, x, rd, color, icon, typeName, regionName, state } = props;
  const style = { '--c': color, '--x': `${x}px` } as CSSProperties;
  let card;
  if (lod === 'poster') {
    card = (
      <div className="tl-card poster" key="poster">
        <Cover node={node} icon={icon} />
        <div className="tl-poster-text">
          <div className="tt" title={node.title}>
            {node.title}
          </div>
          <div className="sub">
            {node.label ? <span className="lbl">{node.label}</span> : null}
            <span>{formatShort(node.start)}</span>
          </div>
        </div>
        <span className="tl-type-pip" title={typeName}>
          {icon}
        </span>
        {node.commentCount > 0 && <span className="tl-cc">{node.commentCount}</span>}
      </div>
    );
  } else if (lod === 'card') {
    card = (
      <div className="tl-card card" key="card">
        <Cover node={node} icon={icon} className="sm" />
        <div className="tl-card-text">
          <div className="tt">{node.title}</div>
          {node.label ? <div className="lbl">{node.label}</div> : null}
          <div className="meta">
            <span className="ty">
              {icon} {typeName}
              {regionName ? ` · ${regionName}` : ''}
            </span>
            <span className="dt">{dateText(node)}</span>
          </div>
        </div>
        {node.commentCount > 0 && <span className="tl-cc">{node.commentCount}</span>}
      </div>
    );
  } else {
    card = (
      <div className="tl-card chip" key="chip">
        {node.coverThumb ? (
          <CoverImg className="chip-cv" src={node.coverThumb} alt="" draggable={false} loading="lazy" decoding="async" />
        ) : (
          <span className="chip-dot" />
        )}
        <span className="tt">
          {node.title}
          {node.label ? <em> {node.label}</em> : null}
        </span>
      </div>
    );
  }
  return (
    <div className={`tl-item lod-${lod} st-${state}`} data-id={node.id} data-d={d} data-rd={rd} style={style}>
      <div className="tl-item-x">
        {rd > 0 && <div className="tl-range" />}
        {card}
      </div>
    </div>
  );
});

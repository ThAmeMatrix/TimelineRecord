import { type SyntheticEvent } from 'react';
import { useMediaUrl } from '../local/media';

interface Props {
  src?: string | null;
  className?: string;
  alt?: string;
  loading?: 'lazy' | 'eager';
  draggable?: boolean;
  decoding?: 'async' | 'auto' | 'sync';
  onLoad?: (e: SyntheticEvent<HTMLImageElement>) => void;
}

/** 能正确显示本地媒体（media/<id>，运行时解析成 blob URL）与远程图片的 <img> */
export function CoverImg({ src, className, alt = '', loading = 'lazy', draggable, decoding, onLoad }: Props) {
  const url = useMediaUrl(src);
  return <img src={url ?? undefined} className={className} alt={alt} loading={loading} draggable={draggable} decoding={decoding} onLoad={onLoad} />;
}

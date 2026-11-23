import { useContext, useEffect, type ImgHTMLAttributes } from 'react';
import { useAvatarImage } from '../hooks/useAvatarImage';
import { CdnContext } from '../lib/cdn';
import { useDataSaver } from '../lib/dataSaver';
import { publicDressImage } from '../lib/remoteImage';
import { dressUrl, thumbnailPolicyRequest } from '../lib/resourceUrl';
import { ShimmerImage } from './ShimmerImage';

type Props = ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  placeholder?: boolean;
  onUnavailable?: () => void;
};

/** 名片和挂件沿用原电脑地址；只有新版 Remote 将公开图片变成缓存优先的请求。 */
export function DressImage({ src, placeholder, onUnavailable, ...rest }: Props) {
  const { remote, remoteDress } = useContext(CdnContext);
  const candidate = remote && src.startsWith('https://tianquan.gtimg.cn/') ? dressUrl(src) : src;
  const proxy =
    remote && candidate.startsWith('/_media/dress?')
      ? new URL(candidate, 'https://weq.invalid')
      : null;
  const publicImage = proxy && publicDressImage(proxy);
  const fallback = publicImage ? candidate : src;
  if (remoteDress && publicImage)
    return <CachedDressImage src={fallback} onUnavailable={onUnavailable} {...rest} />;
  if (placeholder) return <ShimmerImage src={fallback} {...rest} />;
  return <img src={fallback} {...rest} alt={rest.alt ?? ''} />;
}

function CachedDressImage({
  src,
  onError,
  onLoad,
  onUnavailable,
  ...rest
}: Omit<Props, 'placeholder'>) {
  const allowed = useDataSaver((state) => !state.enabled || state.behavior.dataSaverDress);
  const source = `${thumbnailPolicyRequest(src).src}&_weq_dress_direct=${allowed ? '1' : '0'}`;
  const image = useAvatarImage(source);
  useEffect(() => {
    if (image.failed && allowed) onUnavailable?.();
  }, [image.failed, allowed, onUnavailable]);
  return (
    <img
      {...rest}
      key={image.src}
      ref={image.ref}
      src={image.src}
      alt={rest.alt ?? ''}
      onLoad={(event) => {
        image.onLoad();
        onLoad?.(event);
      }}
      onError={(event) => {
        image.onError();
        onError?.(event);
      }}
    />
  );
}

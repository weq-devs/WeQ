import { useContext, useEffect, useEffectEvent, type ImgHTMLAttributes } from 'react';
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
  onLoadFailed?: () => void;
  reuseRemoteCache?: boolean;
};

/** 名片和挂件沿用原电脑地址；只有新版 Remote 将公开图片变成缓存优先的请求。 */
export function DressImage({
  src,
  placeholder,
  onUnavailable,
  onLoadFailed,
  reuseRemoteCache,
  onError,
  ...rest
}: Props) {
  const { remote, remoteDress } = useContext(CdnContext);
  const candidate = remote && src.startsWith('https://tianquan.gtimg.cn/') ? dressUrl(src) : src;
  const proxy =
    remote && candidate.startsWith('/_media/dress?')
      ? new URL(candidate, 'https://weq.invalid')
      : null;
  const publicImage = proxy && publicDressImage(proxy);
  const fallback = publicImage ? candidate : src;
  if (remoteDress && publicImage && proxy.searchParams.get('intent') !== 'interactive')
    return (
      <CachedDressImage
        src={fallback}
        onUnavailable={onUnavailable}
        onLoadFailed={onLoadFailed}
        onError={onError}
        {...rest}
      />
    );
  const failed: Props['onError'] = (event) => {
    onError?.(event);
    onLoadFailed?.();
  };
  if (placeholder)
    return (
      <ShimmerImage src={fallback} reuseRemoteCache={reuseRemoteCache} onError={failed} {...rest} />
    );
  return <img src={fallback} onError={failed} {...rest} alt={rest.alt ?? ''} />;
}

function CachedDressImage({
  src,
  onError,
  onLoad,
  onUnavailable,
  onLoadFailed,
  ...rest
}: Omit<Props, 'placeholder'>) {
  const allowed = useDataSaver((state) => !state.enabled || state.behavior.dataSaverDress);
  const source = `${thumbnailPolicyRequest(src).src}&_weq_dress_direct=${allowed ? '1' : '0'}`;
  const image = useAvatarImage(source);
  const reportFailure = useEffectEvent(() => {
    onLoadFailed?.();
    if (allowed) onUnavailable?.();
  });
  useEffect(() => {
    if (image.failed) reportFailure();
  }, [image.failed, allowed, source]);
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

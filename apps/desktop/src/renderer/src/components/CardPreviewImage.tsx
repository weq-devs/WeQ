import { useState, type ImgHTMLAttributes } from 'react';
import { useDataSaver } from '../lib/dataSaver';
import { inlineImageUrl, interactiveMediaUrl } from '../lib/resourceUrl';
import { ShimmerImage } from './ShimmerImage';

function CardImage(props: ImgHTMLAttributes<HTMLImageElement>) {
  const [ready, setReady] = useState(false);
  return (
    <img
      {...props}
      style={ready ? undefined : { visibility: 'hidden' }}
      onLoad={() => setReady(true)}
    />
  );
}

export function CardPreviewImage({
  src,
  className,
  label = '加载配图',
  fallbackSrc,
  hideUnavailable,
  mediaLoading,
}: {
  src: string;
  className: string;
  label?: string;
  fallbackSrc?: string;
  hideUnavailable?: boolean;
  mediaLoading?: boolean;
}) {
  const limited = useDataSaver((state) => state.enabled && !state.behavior.dataSaverLinkPreviews);
  const automatic = inlineImageUrl(src, 'link-preview');
  const [requested, setRequested] = useState('');
  const [failedPrimary, setFailedPrimary] = useState('');
  const [failed, setFailed] = useState('');
  const primary = requested === automatic ? interactiveMediaUrl(automatic) : automatic;
  const fallback = fallbackSrc ? inlineImageUrl(fallbackSrc, 'link-preview') : '';
  const fallbackUrl = requested === automatic ? interactiveMediaUrl(fallback) : fallback;
  const url = failedPrimary === primary && fallbackUrl ? fallbackUrl : primary;
  if (failed === url) {
    if (!limited && hideUnavailable) return null;
    return (
      <button
        type="button"
        className={`${className} weq-card-load-image`}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setRequested(automatic);
          setFailedPrimary('');
          setFailed('');
        }}
      >
        {label}
      </button>
    );
  }
  const props = {
    className,
    src: url,
    alt: '',
    loading: requested === automatic ? ('eager' as const) : ('lazy' as const),
    onError: () => {
      if (url === primary && fallbackUrl && fallbackUrl !== primary) setFailedPrimary(primary);
      else setFailed(url);
    },
  };
  return mediaLoading ? (
    <ShimmerImage key={url} {...props} mediaLoading />
  ) : (
    <CardImage key={url} {...props} />
  );
}

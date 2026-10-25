import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { collectionImageUrl } from '../lib/resourceUrl';

/** 离屏移除 src；列表和正文只解码小图，原图由灯箱单独取得。 */
export function CollectionImage({
  originalSrc,
  onLoad,
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { originalSrc: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const image = ref.current;
    if (!image) return;
    const view = image.ownerDocument.defaultView;
    const Observer = view?.IntersectionObserver;
    if (!Observer) {
      setVisible(true);
      return;
    }
    let intersecting = false;
    const update = () =>
      setVisible(intersecting && image.ownerDocument.visibilityState !== 'hidden');
    const observer = new Observer(
      (entries) => {
        intersecting = entries.some((entry) => entry.isIntersecting);
        update();
      },
      { rootMargin: '200px' },
    );
    observer.observe(image);
    image.ownerDocument.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      image.ownerDocument.removeEventListener('visibilitychange', update);
    };
  }, []);
  return (
    <img
      {...props}
      ref={ref}
      width={dimensions?.width ?? props.width}
      height={dimensions?.height ?? props.height}
      src={visible ? collectionImageUrl(originalSrc, true) : undefined}
      loading="lazy"
      decoding="async"
      onLoad={(event) => {
        const image = event.currentTarget;
        if (image.naturalWidth && image.naturalHeight)
          setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
        onLoad?.(event);
      }}
    />
  );
}

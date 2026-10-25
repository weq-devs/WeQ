/**
 * 图片带 shimmer 加载占位：图片字节未就绪时，在图片底下显示一块 shimmer 扫光
 * （复用全局 `.weq-shimmer-block`），加载完成后图片自然盖住它。
 *
 * 渲染为「shimmer 块 + <img>」两个同级元素，不改动调用方的布局结构——只需
 * 保证父容器 `position: relative`（绝大多数缩略图 / 封面容器已具备，见各 CSS）。
 * `src` 变化（含失败回退换源）时会重置 shimmer；`onLoad` / `onError` 与调用方
 * 的处理器合并执行，失败时撤掉 shimmer 避免一直闪烁（调用方通常随后换源或
 * 显示兜底图标）。
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ImgHTMLAttributes,
  type ReactElement,
} from 'react';
import { useRenderDocument, resourceForRenderDocument } from '../lib/renderDocument';
import { useAvatarUrl } from '../hooks/useAvatarUrl';
import { useTabActive } from './RetainedTabs';

export function ShimmerImage({
  className,
  alt = '',
  onLoad,
  onError,
  suspendOffscreen = false,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { suspendOffscreen?: boolean }): ReactElement {
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const ownerDocument = useRenderDocument();
  const tabActive = useTabActive();
  const [visible, setVisible] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const avatarSrc = useAvatarUrl(rest.src, false);
  const src = avatarSrc ? resourceForRenderDocument(avatarSrc, ownerDocument) : rest.src;
  const enabled = !suspendOffscreen || (tabActive && visible);

  useEffect(() => {
    const image = imgRef.current;
    if (!suspendOffscreen || !image) return;
    if (!tabActive) {
      setVisible(false);
      return;
    }
    const doc = image.ownerDocument;
    const Observer = doc.defaultView?.IntersectionObserver;
    let intersecting = !Observer;
    let disposed = false;
    const update = () => {
      if (!disposed) setVisible(intersecting && doc.visibilityState !== 'hidden');
    };
    update();
    const observer = Observer
      ? new Observer(
          (entries) => {
            intersecting = entries.some((entry) => entry.isIntersecting);
            update();
          },
          { rootMargin: '200px' },
        )
      : null;
    observer?.observe(image);
    doc.addEventListener('visibilitychange', update);
    return () => {
      disposed = true;
      observer?.disconnect();
      doc.removeEventListener('visibilitychange', update);
    };
  }, [suspendOffscreen, tabActive, ownerDocument]);

  // src 变化（首次挂载 / 失败回退换源）时重置；已缓存完成的直接显示，避免闪一下。
  useLayoutEffect(() => {
    setLoaded(false);
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
      setLoaded(true);
    }
  }, [src]);

  return (
    <>
      {enabled && !loaded ? <span className="weq-shimmer-block" aria-hidden /> : null}
      <img
        ref={imgRef}
        className={className}
        alt={alt}
        onLoad={(event) => {
          if (!enabled) return;
          const image = event.currentTarget;
          // 保留固有比例，移除 src 后未知尺寸的图片也不能压塌时间线。
          if (suspendOffscreen && image.naturalWidth && image.naturalHeight)
            setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
          setLoaded(true);
          onLoad?.(event);
        }}
        onError={(event) => {
          if (!enabled) return;
          setLoaded(true);
          onError?.(event);
        }}
        {...rest}
        width={rest.width ?? (suspendOffscreen ? dimensions?.width : undefined)}
        height={rest.height ?? (suspendOffscreen ? dimensions?.height : undefined)}
        src={enabled ? src : undefined}
        srcSet={enabled ? rest.srcSet : undefined}
      />
    </>
  );
}

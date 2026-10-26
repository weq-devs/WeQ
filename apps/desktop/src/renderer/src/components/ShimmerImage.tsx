/**
 * 图片未就绪时隐藏浏览器的 alt 文字，显示带 shimmer 的图形占位。
 *
 * 渲染为「占位图形 + <img>」两个同级元素，不改动调用方的布局结构——只需
 * 保证父容器 `position: relative`（绝大多数缩略图 / 封面容器已具备，见各 CSS）。
 * `src` 变化（含失败回退换源）时会重置 shimmer；`onLoad` / `onError` 与调用方
 * 的处理器合并执行，失败时撤掉 shimmer 避免一直闪烁（调用方通常随后换源或
 * 显示兜底图标）。
 */

import {
  useEffect,
  useLayoutEffect,
  useContext,
  useState,
  useSyncExternalStore,
  type ImgHTMLAttributes,
  type ReactElement,
} from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { useRenderDocument, resourceForRenderDocument } from '../lib/renderDocument';
import { useAvatarUrl } from '../hooks/useAvatarUrl';
import { useTabActive } from './RetainedTabs';
import { ChatImageCacheContext } from './ChatImageCacheProvider';
import '../styles/chat-image-preview.css';

const noSubscription = () => () => {};

export function ShimmerImage({
  className,
  alt = '',
  onLoad,
  onError,
  suspendOffscreen = false,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { suspendOffscreen?: boolean }): ReactElement {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const ownerDocument = useRenderDocument();
  const tabActive = useTabActive();
  const [visible, setVisible] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const avatarSrc = useAvatarUrl(rest.src, false);
  const src = avatarSrc ? resourceForRenderDocument(avatarSrc, ownerDocument) : rest.src;
  const cache = useContext(ChatImageCacheContext);
  const cacheKey = JSON.stringify([src, rest.srcSet]);
  const retained = useSyncExternalStore(
    suspendOffscreen && cache ? cache.subscribe : noSubscription,
    () => suspendOffscreen && Boolean(cache?.has(cacheKey)),
  );
  const budget = useSyncExternalStore(
    suspendOffscreen && cache ? cache.subscribe : noSubscription,
    () => cache?.stats().limit ?? 0,
  );
  const active = tabActive && visible;
  const enabled = !suspendOffscreen || active || retained;

  useEffect(() => {
    if (suspendOffscreen && active) return cache?.activate(cacheKey);
  }, [cache, cacheKey, suspendOffscreen, active]);

  // 调大预算时，当前已加载的图片也能加入缓存，不必等一次新的 load。
  useLayoutEffect(() => {
    if (budget > 0 && suspendOffscreen && active && image?.complete && image.naturalWidth > 0)
      cache?.remember(cacheKey, image);
  }, [cache, cacheKey, budget, suspendOffscreen, active, image]);

  useEffect(() => {
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
    // 更换加载节点时保留可见性，等新节点的观察结果；不能先置 false 造成反复挂载。
    if (!Observer || doc.visibilityState === 'hidden') update();
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
  }, [suspendOffscreen, tabActive, ownerDocument, image]);

  // src 变化（首次挂载 / 失败回退换源）时重置；已缓存完成的直接显示，避免闪一下。
  useLayoutEffect(() => {
    setLoaded(false);
    setFailed(false);
    if (image?.complete && image.naturalWidth > 0) {
      setLoaded(true);
    }
  }, [src, image]);

  return (
    <>
      {!enabled || !loaded ? (
        <span className="weq-image-placeholder" role="img" aria-label={alt || '图片'}>
          {enabled && !failed ? <span className="weq-shimmer-block" aria-hidden /> : null}
          <ImageIcon size={28} strokeWidth={1.5} aria-hidden />
        </span>
      ) : null}
      <img
        // 暂停和换源使用独立节点，旧请求（含移除 src）的迟到事件不能触发当前回退。
        key={JSON.stringify(enabled ? [src, rest.srcSet] : null)}
        ref={setImage}
        className={className}
        alt={alt}
        aria-hidden={!enabled || !loaded ? true : undefined}
        onLoad={(event) => {
          if (!enabled) return;
          const image = event.currentTarget;
          // 保留固有比例，移除 src 后未知尺寸的图片也不能压塌时间线。
          if (suspendOffscreen && image.naturalWidth && image.naturalHeight)
            setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
          if (suspendOffscreen) cache?.remember(cacheKey, image);
          setLoaded(true);
          onLoad?.(event);
        }}
        onError={(event) => {
          if (!enabled) return;
          setLoaded(false);
          setFailed(true);
          onError?.(event);
        }}
        {...rest}
        style={{ ...rest.style, opacity: enabled && loaded ? rest.style?.opacity : 0 }}
        width={rest.width ?? (suspendOffscreen ? (dimensions?.width ?? 120) : undefined)}
        height={rest.height ?? (suspendOffscreen ? (dimensions?.height ?? 96) : undefined)}
        src={enabled ? src : undefined}
        srcSet={enabled ? rest.srcSet : undefined}
      />
    </>
  );
}

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
  useEffectEvent,
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
import { observePlaceholderAnimation } from '../lib/placeholderAnimation';
import { useTabActive } from './RetainedTabs.shared';
import { ChatImageCacheContext } from './ChatImageCacheProvider.shared';
import '../styles/chat-image-preview.css';
import { useDataSaver } from '../lib/dataSaver';
import { thumbnailPolicyRequest } from '../lib/resourceUrl';
import { MediaLoadingRing } from './TransferRing';
import { requestRemoteImage } from '../lib/remoteImage';
import { createChatImageUrl } from '../lib/chatImageCache';
import {
  putRemoteCachedMedia,
  readRemoteCachedMedia,
  remoteCachedResource,
  remoteDataCacheStatus,
} from '../lib/remoteDataCache';
import { fetchChatThumbnail } from '../lib/chatThumbnail';
import { MessageImageContext } from '../lib/messageImageContext';

const noSubscription = () => () => {};

export function ShimmerImage({
  className,
  alt = '',
  onLoad,
  onError,
  suspendOffscreen = false,
  mediaLoading = false,
  remoteImageSrc,
  abortableThumbnail = false,
  onThumbnailError,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & {
  suspendOffscreen?: boolean;
  mediaLoading?: boolean;
  remoteImageSrc?: string | null;
  abortableThumbnail?: boolean;
  onThumbnailError?: () => void;
}): ReactElement {
  const [loaded, setLoaded] = useState(false);
  const limited = useDataSaver((state) => state.enabled);
  useDataSaver((state) => (state.enabled ? state.behavior : null));
  const noPrefetch = useDataSaver((state) => state.enabled && !state.behavior.dataSaverPrefetch);
  const [failed, setFailed] = useState(false);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const ownerDocument = useRenderDocument();
  const messageImage = useContext(MessageImageContext);
  const tabActive = useTabActive();
  const [visible, setVisible] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const avatarSrc = useAvatarUrl(rest.src, false);
  const source = avatarSrc ?? rest.src;
  const request = source ? thumbnailPolicyRequest(source) : { src: source, policyKey: '' };
  const src = request.src
    ? resourceForRenderDocument(remoteCachedResource(request.src), ownerDocument)
    : request.src;
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
  const active = messageImage || (tabActive && visible);
  const enabled = !suspendOffscreen || active || retained;
  const directUrl = limited ? null : remoteImageSrc;
  const proxyUrl = abortableThumbnail && !rest.srcSet ? src : undefined;
  const managed = Boolean(directUrl || proxyUrl);
  const requestKey = JSON.stringify([cacheKey, directUrl, proxyUrl]);
  const cachedSource = managed && retained ? cache?.source(cacheKey) : undefined;
  const [fetched, setFetched] = useState<{
    key: string;
    blob: Blob | null;
    source?: 'proxy' | 'error';
  }>();
  const result = fetched?.key === requestKey ? fetched : undefined;
  const blob = result?.blob;
  const [directImage, setDirectImage] = useState<{
    blob: Blob;
    asset: ReturnType<typeof createChatImageUrl>;
  }>();
  const asset = directImage && directImage.blob === blob ? directImage.asset : undefined;
  useLayoutEffect(() => {
    if (!blob) {
      setDirectImage(undefined);
      return;
    }
    const asset = createChatImageUrl(blob);
    const release = asset.retain();
    setDirectImage({ blob, asset });
    return release;
  }, [blob]);
  const displayedSrc = managed
    ? result
      ? blob
        ? asset?.src
        : result.source === 'error'
          ? undefined
          : src
      : cachedSource
    : src;
  const showingBlob = Boolean(
    managed &&
      displayedSrc &&
      displayedSrc !== src &&
      (displayedSrc.startsWith('blob:') || displayedSrc.startsWith('data:')),
  );
  const reportThumbnailError = useEffectEvent(() => {
    setFailed(true);
    onThumbnailError?.();
  });
  useEffect(() => {
    if (!enabled) {
      setFetched(undefined);
      return;
    }
    if (!active || !managed || cachedSource || result) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const source = request.src;
      const status = directUrl && source ? await remoteDataCacheStatus() : undefined;
      const local = status && source ? await readRemoteCachedMedia(source, signal) : undefined;
      if (signal.aborted) return;
      const direct =
        local?.blob ?? (directUrl ? await requestRemoteImage(directUrl, signal) : null);
      if (!local && direct && source && status && !signal.aborted)
        void putRemoteCachedMedia(source, direct, status);
      if (signal.aborted) return;
      if (direct || !proxyUrl) {
        setFetched({ key: requestKey, blob: direct });
        return;
      }
      try {
        // Safari 移除图片节点后仍可继续读原响应，显式取消 fetch 才会释放电脑端队列。
        const blob = await fetchChatThumbnail(proxyUrl, signal);
        if (signal.aborted) return;
        if (!blob) {
          setFetched({ key: requestKey, blob: null, source: 'error' });
          reportThumbnailError();
          return;
        }
        setFetched({ key: requestKey, blob, source: 'proxy' });
      } catch {
        if (!signal.aborted) setFetched({ key: requestKey, blob: null });
      }
    })();
    return () => controller.abort();
  }, [
    active,
    directUrl,
    proxyUrl,
    managed,
    requestKey,
    request.src,
    cachedSource,
    enabled,
    result,
  ]);
  const observeLoading = mediaLoading && rest.loading === 'lazy';
  const showRing =
    mediaLoading &&
    tabActive &&
    ((!suspendOffscreen && !observeLoading) || active) &&
    enabled &&
    Boolean(src) &&
    !failed;

  useEffect(() => {
    if (suspendOffscreen && active) return cache?.activate(cacheKey);
  }, [cache, cacheKey, suspendOffscreen, active]);

  // 调大预算时，当前已加载的图片也能加入缓存，不必等一次新的 load。
  useLayoutEffect(() => {
    if (
      !messageImage &&
      budget > 0 &&
      suspendOffscreen &&
      active &&
      image?.complete &&
      image.naturalWidth > 0
    )
      cache?.remember(cacheKey, image, asset);
  }, [cache, cacheKey, budget, suspendOffscreen, active, image, asset, messageImage]);

  useEffect(() => {
    if (messageImage || (!suspendOffscreen && !observeLoading) || !image) return;
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
          { rootMargin: noPrefetch || !suspendOffscreen ? '0px' : '200px' },
        )
      : null;
    observer?.observe(image);
    doc.addEventListener('visibilitychange', update);
    return () => {
      disposed = true;
      observer?.disconnect();
      doc.removeEventListener('visibilitychange', update);
    };
  }, [suspendOffscreen, observeLoading, tabActive, ownerDocument, image, noPrefetch, messageImage]);

  // src 变化（首次挂载 / 失败回退换源）时重置；已缓存完成的直接显示，避免闪一下。
  useLayoutEffect(() => {
    setLoaded(false);
    setFailed(false);
    if (image?.complete && image.naturalWidth > 0) {
      setLoaded(true);
    }
  }, [displayedSrc, image, rest.srcSet]);

  return (
    <>
      {!enabled || !loaded ? (
        <span
          className="weq-image-placeholder"
          role={showRing ? undefined : 'img'}
          aria-label={
            failed ? `${alt || '图片'}未加载${limited ? '（省流量模式）' : ''}` : alt || '图片'
          }
        >
          {showRing ? (
            <MediaLoadingRing label="正在加载图片" />
          ) : enabled && src && !failed && !mediaLoading ? (
            <span ref={observePlaceholderAnimation} className="weq-shimmer-block" aria-hidden />
          ) : null}
          {!showRing && <ImageIcon size={28} strokeWidth={1.5} aria-hidden />}
        </span>
      ) : null}
      <img
        // 暂停和换源使用独立节点，旧请求（含移除 src）的迟到事件不能触发当前回退。
        key={JSON.stringify(enabled ? [src, rest.srcSet, request.policyKey, showingBlob] : null)}
        ref={setImage}
        className={className ? `weq-shimmer-image ${className}` : 'weq-shimmer-image'}
        alt={alt}
        aria-hidden={!enabled || !loaded ? true : undefined}
        onLoad={(event) => {
          if (!enabled) return;
          const image = event.currentTarget;
          // 保留固有比例，移除 src 后未知尺寸的图片也不能压塌时间线。
          if (suspendOffscreen && image.naturalWidth && image.naturalHeight)
            setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
          if (suspendOffscreen && !messageImage) cache?.remember(cacheKey, image, asset);
          setLoaded(true);
          onLoad?.(event);
        }}
        onError={(event) => {
          if (!enabled) return;
          if (directUrl && showingBlob && result?.source !== 'proxy') {
            setFetched({ key: requestKey, blob: null });
            return;
          }
          setLoaded(false);
          setFailed(true);
          onError?.(event);
        }}
        {...rest}
        loading={messageImage ? 'eager' : rest.loading}
        data-weq-message-image-pending={
          (messageImage && Boolean(src) && !loaded && !failed) || undefined
        }
        style={{ ...rest.style, opacity: enabled && loaded ? rest.style?.opacity : 0 }}
        width={rest.width ?? (suspendOffscreen ? (dimensions?.width ?? 120) : undefined)}
        height={rest.height ?? (suspendOffscreen ? (dimensions?.height ?? 96) : undefined)}
        src={enabled ? displayedSrc : undefined}
        srcSet={enabled ? rest.srcSet : undefined}
      />
    </>
  );
}

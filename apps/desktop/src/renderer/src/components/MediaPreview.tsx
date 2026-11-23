import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { ChevronLeft, ChevronRight, CircleDot, Copy, RefreshCw } from 'lucide-react';
import { interactiveMediaUrl } from '../lib/resourceUrl';
import { scheduleBackgroundLoad } from '../lib/backgroundLoad';
import { MediaPreviewShell } from './MediaPreviewShell';
import { MediaLoadStatus, MediaZoomControls, type MediaLoadState } from './MediaPreviewControls';
import { mediaZoomKeyDown } from './MediaPreviewControls.shared';
import { useZoomPan } from './useZoomPan';
import { PreviewOcr } from './usePreviewOcr';
import { MediaSourceSave } from './MediaSaveControls';
import { MediaLoadingRing, TransferRing } from './TransferRing';
import { useTransferProgress } from '../lib/transferActivity';
import { preferenceValue, useClientPreferences } from '../lib/clientPreferences';
import { useDataSaver } from '../lib/dataSaver';
import { useVideoBuffering } from '../hooks/useVideoBuffering';
import { exportMedia } from '../lib/mediaExport';
import { useToastApi } from './Toast.shared';
import { retainObjectUrl } from '../lib/objectUrl';
import {
  resourceForRenderDocument,
  RenderDocumentContext,
  useRenderDocument,
} from '../lib/renderDocument';
import { mediaRetryUrl } from '../lib/mediaRetryUrl';
import { NotificationSourceProvider } from '../lib/notificationNavigation';
import { notificationSource } from '../lib/notificationNavigation.shared';
import { openMediaPreview } from './mediaPreviewStore.shared';
import { topSurface } from '../lib/surfaceEscape';
import type { MediaPreviewOptions, PreviewMedia } from './mediaPreviewTypes';
import { mergePreviewMedia } from './MediaPreview.shared';

export type { PreviewMedia, MediaPreviewOptions } from './mediaPreviewTypes';

type OriginalImageRequest = {
  key: string;
  id: string;
  url: string;
  phase: 'download' | 'decode' | 'ready' | 'failed';
};

export function MediaPreview(options: MediaPreviewOptions) {
  const contextDocument = useRenderDocument();
  const { items: supplied, onClose, ownerDocument = contextDocument, active = true } = options;
  const [items, setItems] = useState(supplied);
  const [key, setKey] = useState(options.initialKey ?? supplied[options.initialIndex ?? 0]?.key);
  const [older, setOlder] = useState(options.hasOlder ?? false);
  const [newer, setNewer] = useState(options.hasNewer ?? false);
  const [pending, setPending] = useState<'older' | 'newer' | null>(null);
  const [pageErrors, setPageErrors] = useState<Array<'older' | 'newer'>>([]);
  const [pageNotice, setPageNotice] = useState('');
  const live = useRef(true);
  const pageRequest = useRef(0);
  const pageLoading = useRef(new Map<'older' | 'newer', number>());
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      pageRequest.current++;
      pageLoading.current.clear();
    };
  }, []);
  useEffect(() => {
    setItems((previous) => mergePreviewMedia(previous, supplied));
  }, [supplied]);
  const currentIndex = items.findIndex((item) => item.key === key);
  const originalItem = items[currentIndex];
  const mediaLoads = useRef(
    new Map<
      string,
      {
        load: NonNullable<PreviewMedia['load']>;
        promise: ReturnType<NonNullable<PreviewMedia['load']>>;
      }
    >(),
  );
  const item = useMemo(() => {
    if (!originalItem?.load) return originalItem;
    const load = originalItem.load;
    return {
      ...originalItem,
      load: (refresh = false) => {
        if (refresh) mediaLoads.current.delete(originalItem.key);
        let cached = mediaLoads.current.get(originalItem.key);
        if (!cached || cached.load !== load) {
          const promise = Promise.resolve().then(() => load());
          cached = { load, promise };
          mediaLoads.current.set(originalItem.key, cached);
          void promise.catch(() => {
            if (mediaLoads.current.get(originalItem.key)?.promise === promise)
              mediaLoads.current.delete(originalItem.key);
          });
        }
        return cached.promise;
      },
    };
  }, [originalItem]);
  const readPage = useCallback(
    async (direction: 'older' | 'newer', navigate: boolean) => {
      if (
        !options.loadPage ||
        pageLoading.current.has(direction) ||
        (navigate && pageLoading.current.size > 0)
      )
        return;
      const request = pageRequest.current;
      pageLoading.current.set(direction, request);
      if (navigate) setPending(direction);
      setPageErrors((previous) =>
        previous.includes(direction) ? previous.filter((entry) => entry !== direction) : previous,
      );
      try {
        const page = await options.loadPage(direction);
        if (!live.current || request !== pageRequest.current) return;
        const additions = page.items.filter((entry) => !items.some((old) => old.key === entry.key));
        setItems((previous) =>
          direction === 'older'
            ? mergePreviewMedia(additions, previous)
            : mergePreviewMedia(previous, additions),
        );
        (direction === 'older' ? setOlder : setNewer)(page.hasMore);
        if (navigate) {
          const next = direction === 'older' ? additions.at(-1) : additions[0];
          if (next) setKey(next.key);
          else
            setPageNotice(
              page.hasMore
                ? `本批没有新媒体，仍可继续查找${direction === 'older' ? '更早' : '更新'}的媒体`
                : `没有${direction === 'older' ? '更早' : '更新'}的媒体`,
            );
        }
      } catch {
        if (live.current && request === pageRequest.current)
          setPageErrors((previous) => [...previous, direction]);
      } finally {
        if (pageLoading.current.get(direction) === request) pageLoading.current.delete(direction);
        if (navigate && live.current && request === pageRequest.current) setPending(null);
      }
    },
    [items, options.loadPage],
  );
  useEffect(() => {
    if (!active || !options.prefetchAdjacent || currentIndex < 0) return;
    const before = currentIndex <= 1 && older && !pageErrors.includes('older');
    const after = currentIndex >= items.length - 2 && newer && !pageErrors.includes('newer');
    if (!before && !after) return;
    // 先显示当前媒体，再在空闲时查邻项；空页沿游标续查也要让出交互时间。
    const prefetch = () => {
      if (before) void readPage('older', false);
      if (after) void readPage('newer', false);
    };
    const view = ownerDocument.defaultView;
    if (view && view !== window) {
      const timer = view.setTimeout(prefetch, 150);
      return () => view.clearTimeout(timer);
    }
    return scheduleBackgroundLoad(prefetch, 150);
  }, [
    active,
    ownerDocument,
    options.prefetchAdjacent,
    currentIndex,
    items.length,
    older,
    newer,
    pageErrors,
    readPage,
  ]);
  async function move(direction: 'older' | 'newer') {
    if (pending) return;
    setPageNotice('');
    const adjacent = items[currentIndex + (direction === 'older' ? -1 : 1)];
    if (adjacent) {
      setKey(adjacent.key);
      return;
    }
    if (options.prefetchAdjacent || !(direction === 'older' ? older : newer)) return;
    await readPage(direction, true);
  }
  const close = useCallback(() => onClose(), [onClose]);
  if (!item) return null;
  const multi = items.length > 1 || older || newer || options.prefetchAdjacent;
  return (
    <RenderDocumentContext.Provider value={ownerDocument}>
      <MediaPreviewItem
        item={item}
        livePhotoToggle={options.livePhotoToggle}
        ownerDocument={ownerDocument}
        active={active}
        onClose={close}
        title={item.title || options.label || (item.kind === 'image' ? '图片预览' : '视频预览')}
        label={options.label}
        count={
          <>
            {currentIndex + 1} / {items.length}
            {older || newer ? ' · 已加载，可继续浏览' : ''}
            {item.isLivePhoto ? ' · 实况' : ''}
          </>
        }
        onMove={multi ? (direction) => void move(direction) : undefined}
        canOlder={!pending && (currentIndex > 0 || (!options.prefetchAdjacent && older))}
        canNewer={
          !pending && (currentIndex < items.length - 1 || (!options.prefetchAdjacent && newer))
        }
        business={
          <>
            {pending ? <p role="status">正在加载更多媒体…</p> : null}
            {!pending && pageNotice ? <p role="status">{pageNotice}</p> : null}
            {pageErrors.map((direction) => (
              <button
                key={direction}
                type="button"
                className="weq-lightbox-action"
                aria-label={`重试加载${direction === 'older' ? '更早' : '更新'}的媒体`}
                onClick={() => void readPage(direction, !options.prefetchAdjacent)}
              >
                <RefreshCw size={16} aria-hidden />
                加载失败，重试
              </button>
            ))}
            {options.renderActions?.(item)}
          </>
        }
      />
    </RenderDocumentContext.Provider>
  );
}

function MediaPreviewItem(props: Parameters<typeof MediaPreviewItemBody>[0]) {
  const { item, livePhotoToggle } = props;
  const source = useMemo(
    () =>
      notificationSource(
        {
          kind: 'local',
          open: () => {
            window.focus();
            return openMediaPreview({ items: [item], livePhotoToggle });
          },
        },
        '返回这项媒体',
      ),
    [item, livePhotoToggle],
  );
  return (
    <NotificationSourceProvider source={source}>
      <MediaPreviewItemBody {...props} />
    </NotificationSourceProvider>
  );
}

function MediaPreviewItemBody({
  item: media,
  livePhotoToggle,
  ownerDocument,
  active,
  onClose,
  title,
  label,
  count,
  onMove,
  canOlder,
  canNewer,
  business,
}: {
  item: PreviewMedia;
  livePhotoToggle?: boolean;
  ownerDocument: Document;
  active: boolean;
  onClose: () => void;
  title: string;
  label?: string;
  count: ReactNode;
  onMove?: (direction: 'older' | 'newer') => void;
  canOlder: boolean;
  canNewer: boolean;
  business: ReactNode;
}) {
  const notificationToast = useToastApi();
  const [staticPhotoKey, setStaticPhotoKey] = useState<string>();
  const livePhotoPoster =
    livePhotoToggle && media.kind === 'video' && media.isLivePhoto === true
      ? media.poster
      : undefined;
  const staticPhoto = staticPhotoKey === media.key ? livePhotoPoster : undefined;
  const showingStaticPhoto = Boolean(staticPhoto);
  const item: PreviewMedia = staticPhoto
    ? { key: media.key, kind: 'image', src: staticPhoto, title: media.title }
    : media;
  const [resolved, setResolved] = useState<{
    key: string;
    src: string;
    kind: 'image' | 'video';
    saveSrc: string;
  } | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [status, setStatus] = useState<MediaLoadState>('loading');
  const [request, setRequest] = useState<OriginalImageRequest>();
  const originalRequest = request?.key === item.key ? request : undefined;
  const originalProgress = useTransferProgress(originalRequest?.id);
  const autoOriginal = useClientPreferences(() => preferenceValue('autoDownloadPreviewOriginal'));
  const dataSaver = useDataSaver((state) => state.enabled);
  const resolvedItem = !showingStaticPhoto && resolved?.key === item.key ? resolved : undefined;
  const current = resolvedItem ?? item;
  const original = item.originalImage;
  const sources = [
    ...new Set(
      [original?.cachedSrc, current.src, ...(item.fallbackSources ?? [])]
        .filter((value): value is string => Boolean(value))
        .map(interactiveMediaUrl),
    ),
  ];
  const originalReady = originalRequest?.phase === 'ready';
  const originalPending =
    originalRequest?.phase === 'download' || originalRequest?.phase === 'decode';
  const originalSource = originalReady ? original?.src : undefined;
  const previewSrc = resourceForRenderDocument(sources[sourceIndex] ?? '', ownerDocument);
  const source = originalSource ?? sources[sourceIndex] ?? '';
  const src = resourceForRenderDocument(source, ownerDocument);
  const zoom = useZoomPan(`${item.key}:${attempt}:${showingStaticPhoto}`, {
    clickZoom: current.kind === 'image',
    layoutScale: current.kind === 'image',
    onSwipe: onMove
      ? (direction) => {
          if (direction === 'left' ? canNewer : canOlder)
            onMove(direction === 'left' ? 'newer' : 'older');
        }
      : undefined,
    onTapOutside: (clientX, element) => {
      const bounds = element.getBoundingClientRect();
      if (onMove) onMove(clientX < bounds.left + bounds.width / 2 ? 'older' : 'newer');
      else onClose();
    },
  });
  const image = useRef<HTMLImageElement | null>(null);
  const [imageFrame, setImageFrame] = useState<HTMLDivElement | null>(null);
  const [ocrActions, setOcrActions] = useState<HTMLSpanElement | null>(null);
  const setFrame = useCallback(
    (element: HTMLDivElement | null) => {
      setImageFrame(element);
      zoom.setEl(element);
    },
    [zoom.setEl],
  );
  const video = useRef<HTMLVideoElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [intrinsic, setIntrinsic] = useState<{ key: string; width: number; height: number }>();
  const eventKey = `${item.key}:${current.kind}:${previewSrc}:${attempt}`;
  const imageKey = originalReady ? originalRequest.id : eventKey;
  const imagePixels = intrinsic?.key === imageKey ? intrinsic : undefined;
  const buffering = useVideoBuffering(eventKey, active && current.kind === 'video');
  const latestEvent = useRef(eventKey);
  latestEvent.current = eventKey;
  const setVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      video.current = element;
      zoom.setEl(element);
    },
    [zoom.setEl],
  );
  const sourcesKey = JSON.stringify([...new Set([item.src, ...sources])]);
  useEffect(() => {
    const releases = (JSON.parse(sourcesKey) as string[]).map(retainObjectUrl);
    return () => {
      for (const release of releases) release();
    };
  }, [sourcesKey]);
  useEffect(() => {
    if (!item.load) return;
    let live = true;
    void item
      .load(attempt > 0)
      .then((value) => {
        if (!live) return;
        setResolved({ ...value, key: item.key, saveSrc: value.src });
        setSourceIndex(0);
        setDetailError(false);
      })
      .catch(() => {
        if (!live) return;
        if (item.kind === 'image' && item.src) setDetailError(true);
        else setStatus('error');
      });
    return () => {
      live = false;
    };
  }, [item.key, item.load, item.kind, item.src, attempt]);
  useLayoutEffect(() => {
    setStatus('loading');
  }, [eventKey]);
  useLayoutEffect(() => {
    setStaticPhotoKey(undefined);
  }, [media.key]);
  useLayoutEffect(() => {
    setSourceIndex(0);
    setDetailError(false);
    setAttempt(0);
    setRequest(undefined);
  }, [item.key, showingStaticPhoto]);
  const measure = useCallback(() => {
    if (!image.current) return;
    const { offsetWidth: width, offsetHeight: height } = image.current;
    setSize((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height },
    );
  }, []);
  const recordImageSize = useCallback((key: string, element: HTMLImageElement) => {
    const { naturalWidth: width, naturalHeight: height } = element;
    if (width && height) setIntrinsic({ key, width, height });
  }, []);
  const startOriginal = useCallback((key: string, source: string, automatic: boolean) => {
    const id = crypto.randomUUID();
    const url = new URL(source, document.baseURI);
    url.searchParams.set('transferId', id);
    if (automatic) {
      url.searchParams.set('autoOriginal', '1');
      url.searchParams.delete('ds');
    }
    setRequest({ key, id, url: url.href, phase: 'download' });
  }, []);
  const canFetchOriginal = Boolean(original && sourceIndex > 0);
  useEffect(() => {
    if (active && autoOriginal && !dataSaver && canFetchOriginal && !originalRequest && original)
      startOriginal(item.key, original.src, true);
  }, [
    active,
    autoOriginal,
    dataSaver,
    canFetchOriginal,
    originalRequest,
    original,
    item.key,
    startOriginal,
  ]);
  useLayoutEffect(() => {
    if (originalReady && image.current) recordImageSize(imageKey, image.current);
  }, [imageKey, originalReady, recordImageSize]);
  useLayoutEffect(measure, [imagePixels, zoom.scale, measure]);
  useEffect(() => {
    const viewport = ownerDocument.defaultView;
    viewport?.addEventListener('resize', measure);
    return () => viewport?.removeEventListener('resize', measure);
  }, [ownerDocument, measure]);
  useEffect(() => {
    const player = video.current;
    if (!active) player?.pause();
    return () => {
      player?.pause();
    };
  }, [active, eventKey]);
  const retry = () => {
    setSourceIndex(0);
    setAttempt((value) => value + 1);
    setDetailError(false);
  };
  const displayStatus = originalReady ? 'ready' : status;
  const ready = displayStatus === 'ready';
  const usingThumbnail = canFetchOriginal && !originalReady;
  const decodingOriginal = originalRequest?.phase === 'decode';
  const originalProgressLabel = decodingOriginal ? '正在解码原图' : '正在下载原图';
  const originalMiB = original?.bytes ? original.bytes / 1024 ** 2 : undefined;
  const originalSize = originalMiB
    ? `（${originalMiB < 0.01 ? '<0.01' : originalMiB.toFixed(2)} MiB）`
    : '';
  async function copy() {
    const result = await exportMedia(
      { url: src, name: item.title, previewImage: image.current },
      'clipboard',
      ownerDocument,
    );
    notificationToast.push(
      result.ok
        ? { tone: 'success', title: '已复制到剪贴板' }
        : { tone: 'error', title: '复制失败', message: result.error },
    );
  }
  // 等待视频原片时不把封面或占位来源误挂到播放器。
  const waiting = Boolean(item.load && item.kind === 'video' && !resolvedItem);
  return (
    <MediaPreviewShell
      title={title}
      ariaLabel={label}
      count={count}
      ownerDocument={ownerDocument}
      active={active}
      onClose={onClose}
      onWheelAt={zoom.wheelAt}
      onMediaPointerDown={current.kind === 'image' ? zoom.onPointerDown : undefined}
      onBackdrop={(side) => (onMove ? onMove(side === 'left' ? 'older' : 'newer') : onClose())}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (
          event.defaultPrevented ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          topSurface(ownerDocument) !== event.currentTarget ||
          target.closest(
            'input, textarea, select, video, [contenteditable="true"], [role="menu"], .weq-ocr-panel',
          )
        )
          return;
        if (!zoom.zoomed && onMove && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          onMove(event.key === 'ArrowLeft' ? 'older' : 'newer');
        } else if (ready) mediaZoomKeyDown(event, zoom);
      }}
      footer={
        <>
          <div className="weq-lightbox-actions">
            <MediaZoomControls zoom={zoom} disabled={!ready} />
            {livePhotoPoster ? (
              <button
                type="button"
                className="weq-lightbox-action"
                aria-pressed={!showingStaticPhoto}
                onClick={() => setStaticPhotoKey(showingStaticPhoto ? undefined : media.key)}
              >
                <CircleDot size={16} aria-hidden />
                实况
              </button>
            ) : null}
            <span ref={setOcrActions} style={{ display: 'contents' }} />
            {original && usingThumbnail ? (
              originalPending ? (
                <span className="weq-lightbox-action weq-lightbox-original weq-transfer-control">
                  <TransferRing
                    size={16}
                    label={originalProgressLabel}
                    progress={
                      decodingOriginal
                        ? { phase: 'confirming' }
                        : (originalProgress ?? { phase: 'download' })
                    }
                  />
                  {originalProgressLabel}
                  {originalSize}
                </span>
              ) : (
                <button
                  type="button"
                  className="weq-lightbox-action weq-lightbox-original"
                  onClick={() => startOriginal(item.key, original.src, false)}
                >
                  {originalRequest?.phase === 'failed' ? '重试原图' : '查看原图'}
                  {originalSize}
                </button>
              )
            ) : null}
            {item.saveSource !== null &&
            (!original || ready) &&
            ((!waiting &&
              (!item.load || resolvedItem || detailError) &&
              source &&
              !source.startsWith('blob:')) ||
              item.saveSource) ? (
              <MediaSourceSave
                key={`${item.key}:${source}`}
                source={
                  originalSource || !item.saveSource
                    ? {
                        kind: 'url',
                        url: originalSource ?? resolvedItem?.saveSrc ?? source,
                        name: item.title,
                        progressTarget: item.progressTarget,
                      }
                    : item.saveSource.kind === 'url' && item.progressTarget
                      ? { ...item.saveSource, progressTarget: item.progressTarget }
                      : item.saveSource
                }
                className="weq-lightbox-action"
                label={
                  item.saveLabel ??
                  (usingThumbnail || (detailError && !resolvedItem)
                    ? '保存预览图'
                    : current.kind === 'image'
                      ? '保存图片'
                      : '保存视频')
                }
                ownerDocument={ownerDocument}
              />
            ) : null}
            {current.kind === 'image' ? (
              <button
                type="button"
                className="weq-lightbox-action"
                aria-label="复制到剪贴板"
                title="复制到剪贴板"
                disabled={!ready}
                onClick={() => void copy()}
              >
                <Copy size={15} />
                复制
              </button>
            ) : null}
            {detailError ? (
              <button
                type="button"
                className="weq-lightbox-action"
                onClick={retry}
                title="原图读取失败，重试"
                aria-label="重试读取原图"
              >
                <RefreshCw size={16} aria-hidden />
                重试原图
              </button>
            ) : null}
          </div>
          <div className="weq-preview-business">{business}</div>
        </>
      }
    >
      {onMove ? (
        <button
          type="button"
          className="weq-preview-side is-left"
          aria-label="上一项媒体"
          title="上一项"
          disabled={!canOlder}
          onClick={() => onMove('older')}
        >
          <ChevronLeft size={26} />
        </button>
      ) : null}
      <div
        className={
          current.kind === 'image'
            ? 'weq-lightbox-stage weq-lightbox-image-stage'
            : 'weq-lightbox-stage'
        }
        data-media-state={displayStatus}
        aria-busy={displayStatus === 'loading'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {!waiting && current.kind === 'image' ? (
          <div
            ref={setFrame}
            className="weq-lightbox-frame"
            data-image-sized={imagePixels ? '' : undefined}
            style={
              {
                ...zoom.style,
                touchAction: 'none',
                ...(imagePixels && {
                  '--weq-preview-natural-width': `${imagePixels.width}px`,
                  '--weq-preview-ratio': imagePixels.width / imagePixels.height,
                  '--weq-preview-scale': zoom.scale,
                }),
              } as CSSProperties
            }
            onMouseDown={zoom.onMouseDown}
            onPointerDown={zoom.onPointerDown}
          >
            {!originalReady ? (
              <img
                key={`${item.key}:${attempt}`}
                ref={image}
                className="weq-lightbox-image"
                src={mediaRetryUrl(previewSrc, attempt)}
                alt={item.title || '图片'}
                draggable={false}
                onLoad={(event) => {
                  if (latestEvent.current !== eventKey) return;
                  recordImageSize(eventKey, event.currentTarget);
                  setStatus('ready');
                  measure();
                }}
                onError={() => {
                  if (latestEvent.current !== eventKey) return;
                  if (sourceIndex + 1 < sources.length) {
                    setSourceIndex((value) => value + 1);
                    setStatus('loading');
                  } else if (resolvedItem && resolvedItem.src !== item.src && item.src) {
                    setResolved({
                      key: item.key,
                      src: item.src,
                      kind: 'image',
                      saveSrc: resolvedItem.saveSrc,
                    });
                    setSourceIndex(0);
                    setDetailError(true);
                  } else setStatus('error');
                }}
              />
            ) : null}
            {originalRequest && (originalPending || originalReady) ? (
              <img
                key={originalRequest.id}
                ref={originalReady ? image : undefined}
                className="weq-lightbox-image"
                style={originalReady ? undefined : { display: 'none' }}
                src={originalRequest.url}
                alt={originalReady ? item.title || '图片' : ''}
                draggable={false}
                onLoad={(event) => {
                  if (originalRequest.phase !== 'download') return;
                  const { id } = originalRequest;
                  const update = (phase: OriginalImageRequest['phase']) =>
                    setRequest((current) => (current?.id === id ? { ...current, phase } : current));
                  update('decode');
                  void event.currentTarget.decode().then(
                    () => update('ready'),
                    () => update('failed'),
                  );
                }}
                onError={() =>
                  setRequest((current) =>
                    current?.id === originalRequest.id ? { ...current, phase: 'failed' } : current,
                  )
                }
              />
            ) : null}
          </div>
        ) : !waiting ? (
          <video
            key={eventKey}
            ref={setVideo}
            className="weq-lightbox-image"
            src={mediaRetryUrl(src, attempt)}
            poster={item.poster ? resourceForRenderDocument(item.poster, ownerDocument) : undefined}
            controls
            autoPlay={active}
            muted={item.isLivePhoto === true}
            playsInline
            {...buffering.events}
            style={{ ...zoom.style, touchAction: zoom.zoomed ? 'none' : 'auto' }}
            onMouseDown={(event) => {
              if (
                zoom.zoomed &&
                event.target === event.currentTarget &&
                event.nativeEvent.offsetY < event.currentTarget.clientHeight - 48
              )
                zoom.onMouseDown(event);
            }}
            onPointerDown={(event) => {
              if (event.nativeEvent.offsetY < event.currentTarget.clientHeight - 48)
                zoom.onPointerDown(event);
            }}
            onFocus={(event) => {
              const player = event.currentTarget;
              const surface = topSurface(ownerDocument);
              if (!player.matches(':focus-visible') && surface?.contains(player))
                surface.focus({ preventScroll: true });
            }}
            onCanPlay={() => {
              buffering.events.onCanPlay();
              if (latestEvent.current === eventKey) setStatus('ready');
            }}
            onError={() => {
              buffering.events.onError();
              if (latestEvent.current === eventKey) setStatus('error');
            }}
          />
        ) : null}
        {active &&
          !waiting &&
          current.kind === 'video' &&
          status !== 'error' &&
          buffering.waiting && <MediaLoadingRing label="正在缓冲视频" />}
        {waiting || current.kind === 'image' || displayStatus === 'error' ? (
          <MediaLoadStatus
            kind={current.kind === 'image' ? '图片' : '视频'}
            status={displayStatus}
            onRetry={retry}
          />
        ) : null}
      </div>
      {onMove ? (
        <button
          type="button"
          className="weq-preview-side is-right"
          aria-label="下一项媒体"
          title="下一项"
          disabled={!canNewer}
          onClick={() => onMove('newer')}
        >
          <ChevronRight size={26} />
        </button>
      ) : null}
      {current.kind === 'image' && item.ocr && imageFrame && ocrActions ? (
        <PreviewOcr
          key={`${eventKey}:${originalSource ?? ''}`}
          src={src}
          context={item.ocr}
          frame={imageFrame}
          actions={ocrActions}
          size={size}
          ready={ready}
        />
      ) : null}
    </MediaPreviewShell>
  );
}

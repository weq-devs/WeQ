import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronLeft, ChevronRight, Copy, RotateCw } from 'lucide-react';
import { compareMessageOrder } from '@weq/codec';
import { MediaPreviewShell } from './MediaPreviewShell';
import {
  MediaLoadStatus,
  MediaZoomControls,
  mediaZoomKeyDown,
  type MediaLoadState,
} from './MediaPreviewControls';
import { useZoomPan } from './useZoomPan';
import { PreviewOcr } from './usePreviewOcr';
import { MediaSourceSave } from './MediaSaveControls';
import { exportMedia } from '../lib/mediaExport';
import { useToast } from './Toast';
import { retainObjectUrl } from '../lib/objectUrl';
import {
  resourceForRenderDocument,
  RenderDocumentContext,
  useRenderDocument,
} from '../lib/renderDocument';
import { mediaRetryUrl } from '../lib/mediaRetryUrl';
import { topSurface } from '../lib/surfaceEscape';
import type { MediaPreviewOptions, PreviewMedia } from './mediaPreviewTypes';
export type { PreviewMedia, MediaPreviewOptions } from './mediaPreviewTypes';

export function mergePreviewMedia(previous: PreviewMedia[], incoming: PreviewMedia[]) {
  const keys = new Set(previous.map((item) => item.key));
  const merged = [
    ...previous,
    ...incoming.filter((item) => !keys.has(item.key) && keys.add(item.key)),
  ];
  if (merged.every((item) => item.order)) {
    // 聊天沿用消息时间线的序号/时间/ID 排序；无序号的其他来源保留传入顺序。
    const groups = new Map<string, PreviewMedia[]>();
    for (const item of merged) {
      const group = groups.get(item.order!.messageId) ?? [];
      group.push(item);
      groups.set(item.order!.messageId, group);
    }
    return [...groups.values()]
      .sort((left, right) => {
        const a = left[0]!.order!,
          b = right[0]!.order!;
        return a.sequence !== undefined && b.sequence !== undefined
          ? compareMessageOrder(
              { msgSeq: a.sequence, sendTime: String(a.time), msgId: a.rawId ?? a.messageId },
              { msgSeq: b.sequence, sendTime: String(b.time), msgId: b.rawId ?? b.messageId },
            )
          : a.time - b.time;
      })
      .flatMap((group) => group.sort((a, b) => a.order!.element - b.order!.element));
  }
  return merged;
}

export function MediaPreview(options: MediaPreviewOptions) {
  const contextDocument = useRenderDocument();
  const { items: supplied, onClose, ownerDocument = contextDocument, active = true } = options;
  const [items, setItems] = useState(supplied);
  const [key, setKey] = useState(options.initialKey ?? supplied[options.initialIndex ?? 0]?.key);
  const [older, setOlder] = useState(options.hasOlder ?? false);
  const [newer, setNewer] = useState(options.hasNewer ?? false);
  const [pending, setPending] = useState<'older' | 'newer' | null>(null);
  const [pageError, setPageError] = useState<'older' | 'newer' | null>(null);
  const [pageNotice, setPageNotice] = useState('');
  const live = useRef(true);
  const pageRequest = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      pageRequest.current++;
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
  async function move(direction: 'older' | 'newer') {
    if (pending) return;
    setPageNotice('');
    const adjacent = items[currentIndex + (direction === 'older' ? -1 : 1)];
    if (adjacent) {
      setKey(adjacent.key);
      return;
    }
    if (!options.loadPage || !(direction === 'older' ? older : newer)) return;
    const request = ++pageRequest.current;
    setPending(direction);
    setPageError(null);
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
      const next = direction === 'older' ? additions.at(-1) : additions[0];
      if (next) setKey(next.key);
      else
        setPageNotice(
          page.hasMore
            ? `本批没有新媒体，仍可继续查找${direction === 'older' ? '更早' : '更新'}的媒体`
            : `没有${direction === 'older' ? '更早' : '更新'}的媒体`,
        );
    } catch {
      if (live.current && request === pageRequest.current) setPageError(direction);
    } finally {
      if (live.current && request === pageRequest.current) setPending(null);
    }
  }
  const close = useCallback(() => onClose(), [onClose]);
  if (!item) return null;
  const multi = items.length > 1 || older || newer;
  return (
    <RenderDocumentContext.Provider value={ownerDocument}>
      <MediaPreviewItem
        item={item}
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
        canOlder={!pending && (currentIndex > 0 || older)}
        canNewer={!pending && (currentIndex < items.length - 1 || newer)}
        business={
          <>
            {pending ? <p role="status">正在加载更多媒体…</p> : null}
            {!pending && pageNotice ? <p role="status">{pageNotice}</p> : null}
            {pageError ? (
              <button
                type="button"
                className="weq-lightbox-action"
                onClick={() => void move(pageError)}
              >
                <RotateCw size={16} />
                加载失败，重试
              </button>
            ) : null}
            {options.renderActions?.(item)}
          </>
        }
      />
    </RenderDocumentContext.Provider>
  );
}

function MediaPreviewItem({
  item,
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
  const current = resolved?.key === item.key ? resolved : item;
  const sources = [...new Set([current.src, ...(item.fallbackSources ?? [])].filter(Boolean))];
  const source = sources[sourceIndex] ?? '';
  const src = resourceForRenderDocument(source, ownerDocument);
  const zoom = useZoomPan(`${item.key}:${attempt}`, {
    clickZoom: current.kind === 'image',
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
  const eventKey = `${item.key}:${current.kind}:${src}:${attempt}`;
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
    setSourceIndex(0);
    setDetailError(false);
    setAttempt(0);
  }, [item.key]);
  const measure = useCallback(() => {
    if (image.current)
      setSize({ width: image.current.offsetWidth, height: image.current.offsetHeight });
  }, []);
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
  const ready = status === 'ready';
  async function copy() {
    const result = await exportMedia({ url: src, name: item.title }, 'clipboard', ownerDocument);
    useToast
      .getState()
      .push(
        result.ok
          ? { tone: 'success', title: '已复制到剪贴板' }
          : { tone: 'error', title: '复制失败', message: result.error },
      );
  }
  // 等待视频原片时不把封面或占位来源误挂到播放器。
  const waiting = Boolean(item.load && item.kind === 'video' && resolved?.key !== item.key);
  return (
    <MediaPreviewShell
      title={title}
      ariaLabel={label}
      count={count}
      ownerDocument={ownerDocument}
      active={active}
      onClose={onClose}
      onWheelAt={zoom.wheelAt}
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
            <span ref={setOcrActions} style={{ display: 'contents' }} />
            {item.saveSource !== null &&
            ((!waiting &&
              (!item.load || resolved?.key === item.key || detailError) &&
              source &&
              !source.startsWith('blob:')) ||
              item.saveSource) ? (
              <MediaSourceSave
                key={`${item.key}:${source}`}
                source={
                  item.saveSource ?? {
                    kind: 'url',
                    url: resolved?.key === item.key ? resolved.saveSrc : source,
                    name: item.title,
                  }
                }
                className="weq-lightbox-action"
                label={
                  item.saveLabel ??
                  (detailError && resolved?.key !== item.key
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
                <RotateCw size={16} />
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
        className="weq-lightbox-stage"
        data-media-state={status}
        aria-busy={status === 'loading'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {!waiting && current.kind === 'image' ? (
          <div
            ref={setFrame}
            className="weq-lightbox-frame"
            style={{ ...zoom.style, touchAction: 'none' }}
            onMouseDown={zoom.onMouseDown}
            onPointerDown={zoom.onPointerDown}
          >
            <img
              key={`${item.key}:${attempt}`}
              ref={image}
              className="weq-lightbox-image"
              src={mediaRetryUrl(src, attempt)}
              alt={item.title || '图片'}
              draggable={false}
              onLoad={() => {
                if (latestEvent.current !== eventKey) return;
                setStatus('ready');
                measure();
              }}
              onError={() => {
                if (latestEvent.current !== eventKey) return;
                if (sourceIndex + 1 < sources.length) {
                  setSourceIndex((value) => value + 1);
                  setStatus('loading');
                } else if (resolved?.key === item.key && resolved.src !== item.src && item.src) {
                  setResolved({
                    key: item.key,
                    src: item.src,
                    kind: 'image',
                    saveSrc: resolved.saveSrc,
                  });
                  setSourceIndex(0);
                  setDetailError(true);
                } else setStatus('error');
              }}
            />
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
              if (latestEvent.current === eventKey) setStatus('ready');
            }}
            onError={() => {
              if (latestEvent.current === eventKey) setStatus('error');
            }}
          />
        ) : null}
        <MediaLoadStatus
          kind={current.kind === 'image' ? '图片' : '视频'}
          status={status}
          onRetry={retry}
        />
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
          key={eventKey}
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

import { ToolbarLabel } from './CompactToolbar';
import { observeCompactToolbar } from './CompactToolbar.shared';
import { usePageDataCache, usePageState } from './PageSnapshots.shared';
import { PageScrollSnapshot } from './PageScrollSnapshot';
import { pageValue } from '../lib/pageSnapshots';
import { isRecentPageRead, PageDataCache } from '../lib/pageDataCache';
import { NumericText } from './NumericText';
/**
 * QzoneAlbumDialog — 左栏「更多功能 → 空间相册」查看器（大灯箱卡片）。
 *
 * 读取自己的 QQ 空间相册（走 qzone web cgi，需要在线 QQ —— p_skey 可由
 * pt_login 本地快速登录兜底，无需注入）。未登录 / 完全离线时给出回退说明文案。
 *
 * 展示逻辑：
 *   - 相册卡片（封面 + 名称 + 媒体数），点击进入内部媒体列表；
 *   - 列表页支持勾选相册并逐页批量导出，按相册分文件夹保存。
 *
 * 媒体列表走分页（pageStart/pageNum），滚动到底部自动加载下一页（哨兵 + 防抖），
 * 不再有「加载更多」按钮。图片一律经自定义资源协议 `weq-media://album?src=…`
 * （主进程代取 + 白名单域名校验）渲染，不用裸 `<img src=远端>`；视频条目点封面
 * 会按 picKey 现取本体 mp4（cgi_floatview_photo_list_v2，列表 cgi 只给封面）后
 * 直接进视频灯箱播放。支持勾选 / 全选后并发下载保存（复用主进程的相册媒体
 * 下载工具函数）。加载态用 skeleton + shimmer 占位。
 */

import {
  useCallback,
  useId,
  useMemo,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useContentMultiSelect } from '../state/contentSelection.shared';
import { ContentReferenceToolbar } from './ContentReferenceToolbar';
import { contentReferenceKey, type ContentReference } from '../../../shared/content_selection';
import { qzoneAlbumMediaKey } from '../../../shared/album_media_identity';
import { mobileBack, useMobileBack } from '../hooks/useMobileNavigation';
import { ArrowLeft, Check, Images, Inbox, Loader2, Play, X, RefreshCw } from 'lucide-react';
import { Modal } from './Dialog';
import type { QzoneAlbumRequest, QzoneMediaDestination } from '../lib/qzoneNavigation';
import { client } from '../trpc/client';
import { albumMediaUrl, interactiveMediaUrl } from '../lib/resourceUrl';
import { ShimmerImage } from './ShimmerImage';
import { useAlbumMediaLoadAction } from '../hooks/useMediaLoadAction';
import { QzoneAlbumTile } from './QzoneAlbumTile';
import { QzoneTime } from './QzoneTime';
import { MediaPreview, type PreviewMedia } from './MediaPreview';
import {
  MediaLoadingRing,
  MediaTransferBadge,
  TransferRing,
  TransferSummary,
} from './TransferRing';
import { useTransferProgress } from '../lib/transferActivity';
import {
  albumMediaTransferTarget,
  qzoneBatchTransferTarget,
} from '../../../shared/transfer_progress';
import { useDebouncedLoading } from '../hooks/useDebouncedLoading';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { useQQReadActivity } from '../hooks/useQQAutoRefresh';
import { useMultiSelection } from '../hooks/useMultiSelection';
import { useAlbumGridMarquee } from '../hooks/useAlbumGridMarquee';
import { QzonePageButton } from '../views/QzonePagination';
import { hasNewQzoneItems, useQzoneRefreshRequest } from '../views/qzoneRefresh';
import { QZONE_ALBUM_PAGE_SIZE as PAGE_NUM } from '../../../shared/qzone_album_export';

/** 相册列表 wire（service QzoneAlbum）。 */
export interface QzoneAlbumWire {
  id: string;
  name: string;
  mediaCount: number;
  coverUrl: string;
  desc: string;
  createTime: number;
  priv: number;
}

/** 相册内媒体 wire（service QzoneAlbumPhoto）。 */
interface QzoneAlbumPhotoWire {
  id: string;
  name: string;
  desc: string;
  url: string;
  thumbUrl: string;
  uploadTime: number;
  isVideo: boolean;
  /** 视频取 mp4 本体的定位键（lloc/sloc）。 */
  picKey: string;
  width: number;
  height: number;
}

function QzoneAlbumMediaButton({
  photo,
  onOpen,
  prepareVideo,
  caption,
  indicator,
}: {
  photo: QzoneAlbumPhotoWire;
  onOpen: (src?: string) => void;
  prepareVideo?: PreviewMedia['load'];
  caption: ReactNode;
  indicator: ReactNode;
}) {
  const [unusableThumb, setUnusableThumb] = useState<string>();
  const [video, setVideo] = useState<{ phase: 'loading' | 'failed' | 'ready'; src?: string }>();
  const raw = photo.thumbUrl && unusableThumb !== photo.thumbUrl ? photo.thumbUrl : photo.url;
  const media = useAlbumMediaLoadAction(
    raw ? albumMediaUrl(raw) : '',
    photo.isVideo ? '视频封面' : '相册图片',
  );
  const videoFallback = photo.isVideo && (!raw || Boolean(media.hint && media.requested));
  const loading = videoFallback ? video?.phase === 'loading' : media.loading;
  const hint =
    videoFallback && video?.phase === 'failed'
      ? '点击重试加载'
      : !loading && video?.phase !== 'ready'
        ? media.hint
        : undefined;
  const title = !videoFallback
    ? media.label
    : video?.phase === 'ready'
      ? '查看视频'
      : video?.phase === 'failed'
        ? '重试加载视频'
        : loading
          ? '正在加载视频'
          : '加载视频';
  async function activate() {
    if (!videoFallback) {
      media.activate(onOpen);
      return;
    }
    if (video?.phase === 'ready') {
      onOpen(video.src);
      return;
    }
    if (loading) return;
    setVideo({ phase: 'loading' });
    try {
      const source = await prepareVideo?.(Boolean(video));
      if (!source?.src || source.kind !== 'video') throw new Error('视频没有可播放地址');
      setVideo({ phase: 'loading', src: interactiveMediaUrl(source.src) });
    } catch {
      setVideo({ phase: 'failed' });
    }
  }
  return (
    <button
      type="button"
      className="weq-qzal-media-body"
      aria-busy={loading || undefined}
      aria-label={photo.name ? `${title}：${photo.name}` : title}
      title={title}
      onClick={() => void activate()}
    >
      <span className="weq-qzal-media-thumb weq-media-frame">
        {videoFallback && video?.src ? (
          <video
            key={video.src}
            src={video.src}
            muted
            playsInline
            preload="auto"
            onLoadedData={() => setVideo({ phase: 'ready', src: video.src })}
            onError={() => setVideo({ phase: 'failed' })}
          />
        ) : (
          <ShimmerImage
            src={media.src || undefined}
            alt="相册媒体"
            loading={media.loading ? 'eager' : 'lazy'}
            mediaLoading
            reuseRemoteCache
            referrerPolicy="no-referrer"
            onLoad={media.onLoad}
            onError={() => {
              media.onError();
              if (!photo.isVideo && media.requested && photo.url && raw !== photo.url)
                setUnusableThumb(photo.thumbUrl);
            }}
          />
        )}
        {videoFallback && loading ? <MediaLoadingRing label="正在加载视频" /> : null}
        {hint ? (
          <span className="weq-media-load-hint" aria-hidden>
            {hint}
          </span>
        ) : null}
        {!videoFallback || video?.phase === 'ready' ? indicator : null}
      </span>
      {caption}
    </button>
  );
}

/** Native placeholder IDs are not unique; keep selections tied to the actual media. */
type AlbumMediaPage = { photos: QzoneAlbumPhotoWire[]; totalInAlbum: number };

function photoKey(photo: QzoneAlbumPhotoWire): string {
  return qzoneAlbumMediaKey(photo);
}

function QzoneBatchProgress({ owner }: { owner: string }) {
  const progress = useTransferProgress(qzoneBatchTransferTarget(owner));
  return progress ? <TransferSummary progress={progress} label="正在下载相册" /> : null;
}

/** 秒级时间戳 → `YYYY-MM-DD`（媒体格子的日期角标）。 */
/** 延时 skeleton 包装（快速加载不闪骨架，与导出中心同款）。 */
function Debounced({ children }: { children: ReactElement }): ReactElement | null {
  const visible = useDebouncedLoading(true, 80);
  if (!visible) return null;
  return children;
}

/** 相册列表骨架（相册卡片形态）。 */
function AlbumListSkeleton(): ReactElement {
  return (
    <Debounced>
      <div className="weq-qzal-skel-grid" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <div className="weq-qzal-skel-card" key={i}>
            <span className="weq-qzal-skel weq-qzal-skel-cover" />
            <span className="weq-qzal-skel weq-qzal-skel-name" />
            <span className="weq-qzal-skel weq-qzal-skel-count" />
          </div>
        ))}
      </div>
    </Debounced>
  );
}

/** 媒体网格骨架（媒体卡片形态）。 */
function MediaGridSkeleton({ cells = 12 }: { cells?: number }): ReactElement {
  return (
    <Debounced>
      <div className="weq-qzal-media-grid" aria-hidden>
        {Array.from({ length: cells }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <div className="weq-qzal-skel-media" key={i}>
            <span className="weq-qzal-skel weq-qzal-skel-thumb" />
          </div>
        ))}
      </div>
    </Debounced>
  );
}

/** Open the confirmed item directly; the full album is still available on request. */
export function QzoneAlbumDestination({
  selfUin,
  target,
  onClose,
  onJumpToAlbum,
}: {
  selfUin: string;
  target: Extract<QzoneMediaDestination, { kind: 'album' }>;
  onClose: () => void;
  onJumpToAlbum: (name: string) => void;
}) {
  const { hostUin, topicId, media } = target;
  const { run, cancel } = useQzoneRequests();
  const [browse, setBrowse] = useState(!media);
  const items = useMemo<PreviewMedia[]>(() => {
    if (!media) return [];
    return [
      {
        key: media.picKey,
        kind: media.kind,
        src: media.src,
        poster: media.poster,
        isLivePhoto: media.isLivePhoto,
        load: async () => {
          const detail = await run((requestId) =>
            client.account.qzone.albumDetail.query({
              selfUin,
              hostUin,
              topicId,
              picKey: media.picKey,
              requestId,
            }),
          );
          if (detail.picKey !== media.picKey) throw new Error('相册详情与当前媒体不匹配。');
          const src = media.kind === 'video' ? detail.videoUrl : detail.imageUrl;
          if (!src && !media.src) throw new Error('相册未返回媒体地址。');
          return { kind: media.kind, src: src ? albumMediaUrl(src) : media.src };
        },
      },
    ];
  }, [media, selfUin, hostUin, topicId, run]);
  return browse ? (
    <QzoneAlbumDialog
      open
      onClose={onClose}
      selfUin={selfUin}
      hostUin={hostUin}
      presentation="panel"
      albumTarget={{ hostUin, topicId, name: '', revision: topicId }}
      onJumpToAlbum={onJumpToAlbum}
    />
  ) : (
    <MediaPreview
      items={items}
      livePhotoToggle
      label={media?.kind === 'video' ? '相册视频' : '相册照片'}
      onClose={onClose}
      renderToolbarActions={() => (
        <button
          title="打开相册"
          type="button"
          className="weq-lightbox-action"
          onClick={() => {
            cancel();
            setBrowse(true);
          }}
        >
          <Images size={16} aria-hidden />
          <ToolbarLabel>打开相册</ToolbarLabel>
        </button>
      )}
    />
  );
}

type QzoneAlbumDialogProps = {
  open: boolean;
  onClose: () => void;
  hostUin: string;
  selfUin: string;
  embedded?: boolean;
  active?: boolean;
  refreshKey?: number;
  albumTarget?: QzoneAlbumRequest;
  presentation?: 'page' | 'panel';
  onJumpToAlbum?: (name: string) => void;
};

type AlbumListSnapshot = {
  albums: QzoneAlbumWire[];
  nextOffset: number | null;
  total: number | null;
  pages: number[];
  checkedAt: number;
};
type AlbumMediaSnapshot = AlbumMediaPage & { pages: number[]; checkedAt: number };

type AlbumPage<T> = {
  items: T[];
  nextOffset: number | null;
  total: number | null;
  warning?: string | null;
};

/** 首页衔接未变时沿用旧分页，变化时重验已浏览的范围及继续加载的位置。 */
async function revalidateAlbumPages<T>(
  readPage: (offset: number) => Promise<AlbumPage<T>>,
  key: (item: T) => string,
  previous?: AlbumPage<T> & { pages: number[] },
) {
  const first = await readPage(0);
  if (previous && first.warning) throw new Error(first.warning);
  const pages = [0];
  if (!previous || previous.pages.length < 2) return { ...first, pages };
  let { items, total, nextOffset } = first;
  if (
    total === previous.total &&
    nextOffset === previous.pages[1] &&
    items.length === nextOffset &&
    items.every((item, index) => {
      const old = previous.items[index];
      return old !== undefined && key(item) === key(old);
    })
  )
    return {
      ...first,
      items: [...items, ...previous.items.slice(items.length)],
      nextOffset: previous.nextOffset,
      pages: previous.pages,
    };

  const known = new Set(items.map(key));
  while (pages.length < previous.pages.length && nextOffset !== null) {
    const offset = nextOffset;
    const page = await readPage(offset);
    if (
      page.warning ||
      !page.items.length ||
      (total !== null && page.total !== null && page.total !== total) ||
      (page.nextOffset !== null && page.nextOffset <= offset) ||
      page.items.some((item) => known.has(key(item)))
    )
      throw new Error(page.warning || '相册目录已变化，请重试。');
    for (const item of page.items) known.add(key(item));
    pages.push(offset);
    items = [...items, ...page.items];
    nextOffset = page.nextOffset;
    total = page.total ?? total;
  }
  return { ...first, items, nextOffset, total, pages };
}

function mediaPage(photos: QzoneAlbumPhotoWire[], total: number, offset = 0) {
  const end = offset + photos.length;
  return { items: photos, total, nextOffset: end < total ? end : null };
}

function readAlbumMedia(hostUin: string, topicId: string, signal?: AbortSignal) {
  return async (pageStart: number) => {
    signal?.throwIfAborted();
    const page = await client.account.qzoneAlbumMedia.query(
      { hostUin, topicId, pageStart, pageNum: PAGE_NUM },
      { signal },
    );
    signal?.throwIfAborted();
    if (!page || !Array.isArray(page.photos)) throw new Error('未取得相册媒体列表。');
    return mediaPage(page.photos, page.totalInAlbum, pageStart);
  };
}

export function QzoneAlbumDialog({ open, ...props }: QzoneAlbumDialogProps): ReactElement | null {
  return open ? (
    <OpenQzoneAlbumDialog key={JSON.stringify([props.selfUin, props.hostUin])} {...props} />
  ) : null;
}

function OpenQzoneAlbumDialog({
  onClose,
  hostUin,
  selfUin,
  embedded = false,
  active: requestedActive = true,
  refreshKey: requestedRefreshKey = 0,
  albumTarget,
  presentation = 'page',
  onJumpToAlbum,
}: Omit<QzoneAlbumDialogProps, 'open'>): ReactElement {
  const titleId = useId();
  const activity = useQQReadActivity(requestedActive);
  const active = activity.enabled;
  const refreshKey = requestedRefreshKey + activity.revision;
  const [fallbackCache] = useState(() => new PageDataCache());
  const pageCache = usePageDataCache(fallbackCache);
  const listKey = JSON.stringify(['qzone-albums', selfUin, hostUin]);
  const [cachedList] = useState(() => pageCache.read<AlbumListSnapshot>(listKey));
  const listCheckedAt = useRef(cachedList?.checkedAt ?? 0);
  const [access, setAccess] = useState<{
    qqOnline: boolean;
    attachEnabled: boolean;
  } | null>(null);
  const [albums, setAlbums] = useState<QzoneAlbumWire[] | null>(cachedList?.albums ?? null);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [albumsError, setAlbumsError] = useState<string | null>(null);
  const [albumNext, setAlbumNext] = useState<number | null>(cachedList?.nextOffset ?? null);
  const [albumTotal, setAlbumTotal] = useState<number | null>(cachedList?.total ?? null);
  const albumPages = useRef(new Set(cachedList?.pages));
  const albumLoaded = useRef(false);
  const [albumRetry, setAlbumRetry] = useState(0);
  const albumPageLock = useRef<AbortController | null>(null);
  const albumSentinel = useRef<HTMLDivElement>(null);
  const { run: runAlbums, cancel: cancelAlbums } = useQzoneRequests();
  /** 选中的相册：null = 相册列表页。 */
  const [lastAlbumId, setLastAlbumId] = usePageState<string | null>(
    `${listKey}:selected`,
    null,
    pageValue.optionalString,
    false,
    !albumTarget,
  );
  const [restoredAlbum] = useState(
    () => cachedList?.albums.find((album) => album.id === lastAlbumId) ?? null,
  );
  const [selected, setSelected] = useState<QzoneAlbumWire | null>(restoredAlbum);
  const refreshRequest = useQzoneRefreshRequest(
    embedded && active && access?.qqOnline === true,
    selected?.id,
  );
  const mediaKey = useCallback(
    (id: string) => JSON.stringify(['qzone-album-media', selfUin, hostUin, id]),
    [selfUin, hostUin],
  );
  const [cachedMedia] = useState(() =>
    restoredAlbum ? pageCache.read<AlbumMediaSnapshot>(mediaKey(restoredAlbum.id)) : undefined,
  );
  const [media, setMedia] = useState<QzoneAlbumPhotoWire[]>(cachedMedia?.photos ?? []);
  const [hasMedia, setHasMedia] = useState(Boolean(cachedMedia));
  const [mediaTotal, setMediaTotal] = useState(cachedMedia?.totalInAlbum ?? 0);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaLoadingMore, setMediaLoadingMore] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const runRef = useRef(0);
  const mediaRead = useRef<AbortController | null>(null);
  const pendingMedia = useRef(Boolean(restoredAlbum));
  const lastRefresh = useRef(refreshKey);
  const [refreshing, setRefreshing] = useState(false);
  /** 与 media 同步的下一页偏移：哨兵回调持旧闭包时也拿得到正确 pageStart。 */
  const mediaLenRef = useRef(cachedMedia?.photos.length ?? 0);
  const mediaPages = useRef(new Set(cachedMedia?.pages));
  const mediaCheckedAt = useRef(cachedMedia?.checkedAt ?? 0);
  const readAlbumPage = useCallback(
    async (offset: number, signal?: AbortSignal): Promise<AlbumPage<QzoneAlbumWire>> => {
      const page = await runAlbums(
        (requestId) =>
          client.account.qzone.albumPage.query({ selfUin, hostUin, requestId, offset }),
        false,
        signal,
      );
      signal?.throwIfAborted();
      return { ...page, items: page.albums };
    },
    [selfUin, hostUin, runAlbums],
  );

  useEffect(() => {
    if (albums && albumPages.current.size)
      pageCache.write(listKey, {
        albums,
        nextOffset: albumNext,
        total: albumTotal,
        pages: [...albumPages.current],
        checkedAt: listCheckedAt.current,
      } satisfies AlbumListSnapshot);
  }, [albums, albumNext, albumTotal, listKey, pageCache]);

  useEffect(() => {
    if (selected && hasMedia)
      pageCache.write(mediaKey(selected.id), {
        photos: media,
        totalInAlbum: mediaTotal,
        pages: [...mediaPages.current],
        checkedAt: mediaCheckedAt.current,
      } satisfies AlbumMediaSnapshot);
  }, [selected, hasMedia, media, mediaTotal, mediaKey, pageCache]);

  /** 打开某相册：拉第一页媒体。 */
  const openAlbum = useCallback(
    (album: QzoneAlbumWire) => {
      const run = ++runRef.current;
      mediaRead.current?.abort();
      mediaRead.current = null;
      pendingMedia.current = true;
      setSelected(album);
      setLastAlbumId(album.id);
      const cached = pageCache.read<AlbumMediaSnapshot>(mediaKey(album.id));
      mediaLenRef.current = cached?.photos.length ?? 0;
      mediaPages.current = new Set(cached?.pages);
      mediaCheckedAt.current = cached?.checkedAt ?? 0;
      setMediaLoadingMore(false);
      setHasMedia(Boolean(cached));
      setMedia(cached?.photos ?? []);
      setMediaTotal(cached?.totalInAlbum ?? 0);
      setMediaError(null);
      setMediaLoading(false);
      if (!active || !access?.qqOnline) return;
      lastRefresh.current = refreshKey;
      if (cached && isRecentPageRead(cached.checkedAt)) {
        pendingMedia.current = false;
        return;
      }
      const controller = new AbortController();
      mediaRead.current = controller;
      setMediaLoading(true);
      void revalidateAlbumPages(
        readAlbumMedia(hostUin, album.id, controller.signal),
        photoKey,
        cached
          ? { ...mediaPage(cached.photos, cached.totalInAlbum), pages: cached.pages }
          : undefined,
      )
        .then(({ items, total, pages }) => {
          if (run !== runRef.current) return;
          setHasMedia(true);
          mediaCheckedAt.current = Date.now();
          mediaPages.current = new Set(pages);
          mediaLenRef.current = items.length;
          setMedia(items);
          setMediaTotal(total ?? items.length);
        })
        .catch((e: unknown) => {
          if (run !== runRef.current) return;
          setMediaError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (run !== runRef.current) return;
          mediaRead.current = null;
          pendingMedia.current = false;
          setMediaLoading(false);
        });
    },
    [active, access, hostUin, mediaKey, pageCache, refreshKey, setLastAlbumId],
  );

  useEffect(() => {
    if (active && access?.qqOnline && selected && pendingMedia.current && !mediaRead.current)
      openAlbum(selected);
  }, [active, access?.qqOnline, selected, openAlbum]);

  // Remote 可能先挂载页面再允许读取，在线检查和相册首页须一起暂停、恢复。
  useEffect(() => {
    if (!active || albumLoaded.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    setAccess(null);
    setAlbumsLoading(true);
    setAlbumsError(null);
    void (async () => {
      const { qqOnline, attachEnabled } = await client.account.getGroupAlbumAccessState.query(
        undefined,
        { signal },
      );
      if (signal.aborted) return;
      setAccess({ qqOnline, attachEnabled });
      if (!qqOnline) return;
      if (albumRetry === 0 && cachedList && isRecentPageRead(cachedList.checkedAt)) {
        albumLoaded.current = true;
        return;
      }
      const page = await revalidateAlbumPages(
        (offset) => readAlbumPage(offset, signal),
        (album) => album.id,
        cachedList ? { ...cachedList, items: cachedList.albums } : undefined,
      );
      signal.throwIfAborted();
      setAlbums(page.items);
      albumLoaded.current = true;
      listCheckedAt.current = page.warning ? 0 : Date.now();
      setAlbumNext(page.nextOffset);
      setAlbumTotal(page.total);
      setAlbumsError(page.warning ?? null);
      albumPages.current = new Set(page.pages);
    })()
      .catch((e: unknown) => {
        if (signal.aborted) return;
        const detail = e instanceof Error ? e.message : String(e);
        setAlbumsError(detail || '暂时无法读取空间相册，请稍后重试。');
      })
      .finally(() => {
        if (!signal.aborted) setAlbumsLoading(false);
      });
    return () => {
      controller.abort();
      cancelAlbums();
    };
  }, [active, albumRetry, cachedList, readAlbumPage, cancelAlbums]);

  useEffect(() => {
    if (!active) {
      runRef.current++;
      cancelAlbums();
      setAlbumsLoading(false);
      setMediaLoading(false);
      setMediaLoadingMore(false);
    }
    return () => {
      runRef.current++;
      mediaRead.current?.abort();
      mediaRead.current = null;
      albumPageLock.current?.abort();
      albumPageLock.current = null;
      cancelAlbums();
    };
  }, [active, selfUin, hostUin, cancelAlbums]);

  const loadAlbumPage = useCallback(async () => {
    if (
      albumNext === null ||
      albumPageLock.current ||
      albumsLoading ||
      refreshing ||
      !active ||
      !access?.qqOnline
    )
      return;
    if (albumPages.current.has(albumNext) || albumPages.current.size >= 200) {
      setAlbumsError('相册分页未前进或达到本轮上限。');
      setAlbumNext(null);
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    albumPageLock.current = controller;
    setAlbumsLoading(true);
    setAlbumsError(null);
    try {
      const page = await runAlbums(
        (requestId) =>
          client.account.qzone.albumPage.query({ selfUin, hostUin, requestId, offset: albumNext }),
        false,
        signal,
      );
      if (signal.aborted) return;
      const previous = albums ?? [];
      const ids = new Set(previous.map((album) => album.id));
      const fresh = page.albums.filter((album) => !ids.has(album.id));
      if (page.albums.length > 0 && fresh.length === 0)
        throw new Error('相册分页重复，已停止自动加载。');
      if (albumTotal !== null && page.total !== null && page.total !== albumTotal)
        throw new Error('相册总数发生变化，请刷新后重试。');
      const knownTotal = page.total ?? albumTotal;
      const pageEnd = albumNext + page.albums.length;
      setAlbums([...previous, ...fresh]);
      setAlbumNext(
        knownTotal === null
          ? page.nextOffset
          : page.albums.length > 0 && pageEnd < knownTotal
            ? pageEnd
            : null,
      );
      setAlbumTotal(knownTotal);
      setAlbumsError(
        page.warning ||
          (page.albums.length === 0 && knownTotal !== null && pageEnd < knownTotal
            ? '相册列表提前结束，未取得声明总数中的全部相册。'
            : fresh.length < page.albums.length
              ? '部分相册重复，清单完整性未确认。'
              : null),
      );
      albumPages.current.add(albumNext);
    } catch (error) {
      if (!signal.aborted) setAlbumsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal.aborted) {
        albumPageLock.current = null;
        setAlbumsLoading(false);
      }
    }
  }, [
    albumNext,
    albumsLoading,
    refreshing,
    active,
    access?.qqOnline,
    selfUin,
    hostUin,
    albums,
    albumTotal,
    runAlbums,
  ]);

  useEffect(() => {
    const element = albumSentinel.current;
    if (
      !element ||
      !active ||
      selected ||
      albumNext === null ||
      albumsError ||
      albumsLoading ||
      !access?.qqOnline
    )
      return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadAlbumPage();
      },
      { root: element.closest('.weq-qzn-scroll, .weq-qzone-album-body'), rootMargin: '300px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, access?.qqOnline, selected, albumNext, albumsError, albumsLoading, loadAlbumPage]);

  const openedTarget = useRef<string | null>(null);
  useEffect(() => {
    if (
      !active ||
      !access?.qqOnline ||
      !albumTarget ||
      albumTarget.hostUin !== hostUin ||
      openedTarget.current === albumTarget.revision ||
      (albumsLoading && !albums) ||
      refreshing ||
      (!albums && !albumsError)
    )
      return;
    openedTarget.current = albumTarget.revision;
    // The explicit album request replaces this entry's background refresh.
    lastRefresh.current = refreshKey;
    const album = albums?.find((item) => item.id === albumTarget.topicId) ?? {
      id: albumTarget.topicId,
      name: albumTarget.name,
      mediaCount: 0,
      coverUrl: '',
      desc: '',
      createTime: 0,
      priv: 0,
    };
    openAlbum(album);
  }, [
    active,
    access?.qqOnline,
    albumTarget,
    hostUin,
    albumsLoading,
    refreshing,
    refreshKey,
    albums,
    albumsError,
    openAlbum,
  ]);

  // 定位相册可先显示媒体，标题按相册 ID 在后续目录页中补全。
  const listedAlbum =
    selected && !selected.name ? albums?.find((album) => album.id === selected.id) : undefined;
  const albumName = selected?.name || listedAlbum?.name || '';
  const needsAlbumName =
    selected && albumTarget?.topicId === selected.id && !albumName && !listedAlbum;
  useEffect(() => {
    if (needsAlbumName && !albumsError && !refreshing) void loadAlbumPage();
  }, [needsAlbumName, albumsError, refreshing, loadAlbumPage]);

  // Re-entering at the latest edge refreshes in place, without resetting selection or media.
  useEffect(() => {
    const manual = refreshRequest?.pending ? refreshRequest : null;
    if (!manual && !albumLoaded.current) {
      lastRefresh.current = refreshKey;
      return;
    }
    if (
      !active ||
      (!manual && refreshKey === lastRefresh.current) ||
      !access?.qqOnline ||
      albumPageLock.current ||
      albumsLoading ||
      mediaRead.current ||
      mediaLoading ||
      mediaLoadingMore
    )
      return;
    lastRefresh.current = refreshKey;
    const run = ++runRef.current;
    const controller = new AbortController();
    const signal = manual ? AbortSignal.any([controller.signal, manual.signal]) : controller.signal;
    let live = true;
    setRefreshing(true);
    setAlbumsError(null);
    void (async () => {
      if (selected) {
        const page = await revalidateAlbumPages(
          readAlbumMedia(hostUin, selected.id, signal),
          photoKey,
          hasMedia
            ? { ...mediaPage(media, mediaTotal), pages: [...mediaPages.current] }
            : undefined,
        );
        if (!live || run !== runRef.current) return;
        setMediaError(null);
        setHasMedia(true);
        mediaCheckedAt.current = Date.now();
        mediaPages.current = new Set(page.pages);
        mediaLenRef.current = page.items.length;
        setMedia(page.items);
        setMediaTotal(page.total ?? page.items.length);
        manual?.resolve(hasNewQzoneItems(media, page.items, photoKey));
      } else {
        const page = await revalidateAlbumPages(
          (offset) => readAlbumPage(offset, signal),
          (album) => album.id,
          albums
            ? {
                items: albums,
                total: albumTotal,
                nextOffset: albumNext,
                pages: [...albumPages.current],
              }
            : undefined,
        );
        if (live && run === runRef.current) {
          if (manual && page.warning) throw new Error(page.warning);
          setAlbums(page.items);
          albumLoaded.current = true;
          listCheckedAt.current = page.warning ? 0 : Date.now();
          setAlbumNext(page.nextOffset);
          setAlbumTotal(page.total);
          setAlbumsError(page.warning ?? null);
          albumPages.current = new Set(page.pages);
          manual?.resolve(hasNewQzoneItems(albums ?? [], page.items, (album) => album.id));
        }
      }
    })()
      .catch((error: unknown) => {
        if (!live || run !== runRef.current) return;
        if (manual) manual.reject(error);
        else setAlbumsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (live) setRefreshing(false);
      });
    return () => {
      live = false;
      controller.abort();
      setRefreshing(false);
    };
  }, [
    active,
    refreshKey,
    refreshRequest,
    access?.qqOnline,
    albumsLoading,
    albums,
    albumNext,
    albumTotal,
    hasMedia,
    media,
    mediaTotal,
    mediaLoading,
    mediaLoadingMore,
    selected,
    hostUin,
    readAlbumPage,
  ]);

  /** 翻页：pageStart = 已加载条数。返回是否成功（哨兵据此决定是否自动重试）。 */
  const loadMore = useCallback(async (): Promise<boolean> => {
    if (!selected || mediaLoading || mediaLoadingMore || refreshing || !active || !access?.qqOnline)
      return true;
    const run = runRef.current;
    const pageStart = mediaLenRef.current;
    setMediaLoadingMore(true);
    try {
      const res = (await client.account.qzoneAlbumMedia.query({
        hostUin,
        topicId: selected.id,
        pageStart,
        pageNum: PAGE_NUM,
      })) as { photos: QzoneAlbumPhotoWire[]; totalInAlbum: number } | null;
      if (run !== runRef.current) return true;
      if (!res || !Array.isArray(res.photos)) return false;
      const photos = res?.photos ?? [];
      if (!photos.length && Number(res.totalInAlbum) > mediaLenRef.current) return false;
      mediaPages.current.add(pageStart);
      mediaLenRef.current += photos.length;
      setMedia((prev) => [...prev, ...photos]);
      setMediaTotal(Number(res?.totalInAlbum ?? mediaLenRef.current));
      return true;
    } catch (_e) {
      // 单页失败：哨兵停止自动触发，底部给出「点击重试」。
      return false;
    } finally {
      if (run === runRef.current) setMediaLoadingMore(false);
    }
  }, [selected, mediaLoading, mediaLoadingMore, refreshing, active, access?.qqOnline, hostUin]);

  const backToList = useCallback(() => {
    runRef.current++;
    mediaRead.current?.abort();
    mediaRead.current = null;
    pendingMedia.current = false;
    mediaLenRef.current = 0;
    setLastAlbumId(null);
    setSelected(null);
    setMedia([]);
    setMediaTotal(0);
    setMediaError(null);
    setMediaLoading(false);
    setMediaLoadingMore(false);
  }, [setLastAlbumId]);
  const surface = useRef<HTMLDivElement>(null);
  useMobileBack(
    requestedActive && Boolean(selected) && !onJumpToAlbum,
    backToList,
    50,
    () => surface.current,
  );

  const offline = access ? !access.qqOnline : false;
  const offlineMode = access ? !access.attachEnabled : false;
  const hasMore = selected ? media.length < mediaTotal : false;
  const title = selected ? albumName || '相册' : '空间相册';

  const body = (
    <div
      ref={surface}
      className={embedded ? 'weq-qzn-timeline weq-qzone-album-embedded' : 'weq-qzone-album'}
    >
      {!embedded ? (
        <header className="weq-qzone-album-head">
          <span className="weq-qzone-album-title">
            <span className="weq-qzone-album-title-icon" aria-hidden="true">
              <Images size={16} strokeWidth={2} />
            </span>
            <strong id={titleId}>{title}</strong>
          </span>
          <span className="weq-qzn-page-count" style={{ flexShrink: 0 }}>
            （已获取{' '}
            <span className="weq-number weq-number-inherit">
              {selected ? mediaPages.current.size : albumPages.current.size}
            </span>{' '}
            页）
          </span>
          <button type="button" className="weq-compose-x" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        </header>
      ) : null}

      <PageScrollSnapshot
        className={embedded ? undefined : 'weq-qzone-album-body'}
        snapshotKey={JSON.stringify([listKey, selected?.id])}
      >
        {refreshing && !refreshRequest?.pending && albums ? (
          <p className="weq-qzn-loading" role="status">
            <Loader2 size={16} className="weq-spin" />
            正在刷新…
          </p>
        ) : null}
        {albumsError && albums ? (
          <div className="weq-qzn-status">
            {albumsError}
            {!albumLoaded.current && active ? (
              <QzonePageButton
                label="重试读取相册"
                retry
                onClick={() => setAlbumRetry((value) => value + 1)}
              />
            ) : null}
          </div>
        ) : null}
        {offline && (albums || hasMedia) ? (
          <p className="weq-qzn-status">QQ 当前不可用，正在显示已读取的相册。</p>
        ) : null}
        {access === null && !albumsError && !albums && !hasMedia ? (
          <div className="weq-qzone-album-empty">
            <Inbox size={26} />
            <Loader2 size={18} className="weq-spin" />
            <span>检查在线状态…</span>
          </div>
        ) : offline && !albums && !hasMedia ? (
          <div className="weq-qzone-album-empty weq-qzone-album-offline">
            <Inbox size={26} />
            <span>{offlineMode ? '完全离线模式已开启' : '需要登录 QQ 客户端'}</span>
            <small>
              {offlineMode
                ? '已关闭「启用 QQ 在线能力」，空间相册需要在线 QQ 实例的 pskey 凭证才能访问。请在设置中开启后重试。'
                : '空间相册需要当前账号的 QQ 客户端在线以获取访问凭证（pskey）。请打开并登录 QQ 后重试。'}
            </small>
          </div>
        ) : albumsError && !albums && !selected ? (
          <div className="weq-qzone-album-empty is-error">
            <Inbox size={26} />
            <span>相册列表加载失败</span>
            <small>{albumsError}</small>
            <button
              type="button"
              onClick={() => setAlbumRetry((value) => value + 1)}
              className="weq-retry-button"
            >
              <RefreshCw size={14} aria-hidden />
              重试
            </button>
          </div>
        ) : selected ? (
          <MediaView
            key={`${selfUin}:${hostUin}:${selected.id}`}
            active={active && access?.qqOnline === true}
            embedded={embedded}
            photos={media}
            total={mediaTotal}
            loading={(mediaLoading || (access === null && active)) && !hasMedia}
            loadingMore={mediaLoadingMore}
            error={mediaError ?? (offline && !hasMedia ? 'QQ 当前不可用，无法读取此相册。' : null)}
            hasMore={hasMore}
            fetchedPages={mediaPages.current.size}
            albumName={albumName}
            hostUin={hostUin}
            selfUin={selfUin}
            topicId={selected.id}
            onBack={() => {
              if (!mobileBack()) backToList();
            }}
            onJumpToAlbum={onJumpToAlbum ? () => onJumpToAlbum(albumName) : undefined}
            onLoadMore={() => loadMore()}
          />
        ) : onJumpToAlbum || !albums ? (
          <AlbumListSkeleton />
        ) : albums.length === 0 ? (
          <div className="weq-qzone-album-empty">
            <Inbox size={26} />
            <span>{albumsError ? '相册清单尚未读取完整' : '这个空间还没有相册'}</span>
          </div>
        ) : (
          <>
            <AlbumGridView
              key={`${selfUin}:${hostUin}`}
              active={active}
              albums={albums}
              hostUin={hostUin}
              pageCount={embedded ? albumPages.current.size : undefined}
              onOpen={(album) => void openAlbum(album)}
            />
            <div ref={albumSentinel} className="weq-qzal-sentinel">
              {albumNext !== null ? (
                albumsError ? (
                  <QzonePageButton
                    label="重试加载相册"
                    retry
                    onClick={() => void loadAlbumPage()}
                  />
                ) : albumsLoading ? (
                  <span className="weq-qzal-sentinel-text" role="status">
                    <Loader2 size={13} className="weq-spin" aria-hidden />
                    正在加载相册…
                    {!embedded ? (
                      <NumericText>{`（已获取 ${albumPages.current.size} 页）`}</NumericText>
                    ) : null}
                  </span>
                ) : null
              ) : (
                <span className="weq-qzal-sentinel-text">
                  {albumTotal === null ? (
                    '已到本次列表末尾（总数未知）'
                  ) : (
                    <NumericText>{`已加载 ${albums.length} / ${albumTotal} 个相册`}</NumericText>
                  )}
                </span>
              )}
            </div>
          </>
        )}
      </PageScrollSnapshot>
    </div>
  );
  return embedded ? (
    body
  ) : (
    <Modal
      presentation={presentation}
      title="空间相册"
      onClose={onClose}
      width={1080}
      labelledBy={titleId}
    >
      {body}
    </Modal>
  );
}

function useAlbumGridSelection({
  ids,
  selected,
  onChange,
  selectionMode,
  setSelectionMode,
  marqueeEnabled,
}: {
  ids: readonly string[];
  selected: ReadonlySet<string>;
  onChange: Dispatch<SetStateAction<Set<string>>>;
  selectionMode: boolean;
  setSelectionMode: (enabled: boolean) => void;
  marqueeEnabled: boolean;
}) {
  const anchorRef = useRef<string | null>(null);
  const multi = useMultiSelection({
    ids,
    selected,
    onChange,
    enabled: selectionMode,
    normalClick: 'passthrough',
    onStart: () => setSelectionMode(true),
    onExit: () => setSelectionMode(false),
    anchorRef,
  });
  const marquee = useAlbumGridMarquee({ enabled: marqueeEnabled, selected, onChange, anchorRef });
  return {
    itemProps: multi.itemProps,
    toggle: multi.toggle,
    selected: marquee.previewIds ?? selected,
    box: marquee.box,
    className: `weq-marquee-grid${marquee.box ? ' is-marquee-selecting' : ''}`,
    rootProps: {
      ...multi.rootProps,
      ...marquee.handlers,
      onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
        multi.rootProps.onPointerDownCapture();
        marquee.handlers.onPointerDownCapture(event);
      },
    },
  };
}

export function AlbumGridView({
  active = true,
  albums,
  hostUin,
  pageCount,
  onOpen,
}: {
  active?: boolean;
  albums: QzoneAlbumWire[];
  hostUin: string;
  pageCount?: number;
  onOpen: (album: QzoneAlbumWire) => void;
}): ReactElement {
  const owner = { kind: 'qzone-albums' as const, container: hostUin };
  const references = useMemo(
    () =>
      new Map(
        albums.map((album) => {
          const ref: ContentReference = {
            kind: 'qzone-album',
            uin: hostUin,
            albumId: album.id,
            name: album.name,
          };
          return [contentReferenceKey(ref), ref];
        }),
      ),
    [albums, hostUin],
  );
  const selection = useContentMultiSelect(owner, active, references);
  const ids = useMemo(() => [...references.keys()], [references]);
  const multi = useAlbumGridSelection({
    ids,
    selected: selection.selectedIds,
    onChange: selection.setSelectedIds,
    selectionMode: selection.selectionMode,
    setSelectionMode: selection.setSelectionMode,
    marqueeEnabled: active,
  });
  const albumKey = (album: QzoneAlbumWire) =>
    contentReferenceKey({ kind: 'qzone-album', uin: hostUin, albumId: album.id });
  const toolbar = <ContentReferenceToolbar owner={owner} selection={selection} loaded={ids} />;

  return (
    <div className="weq-qzal-album-list">
      <QzoneBatchProgress owner={hostUin} />
      {pageCount === undefined ? (
        toolbar
      ) : (
        <div className="weq-qzal-toolbar weq-qzal-list-toolbar">
          {!selection.selectionMode ? (
            <span className="weq-qzn-page-count">
              <NumericText>{`已获取 ${pageCount} 页`}</NumericText>
            </span>
          ) : null}
          {toolbar}
        </div>
      )}
      <div className={`weq-qzal-album-grid ${multi.className}`} {...multi.rootProps}>
        {albums.map((album) => {
          const key = albumKey(album);
          return (
            <QzoneAlbumTile
              key={album.id}
              name={album.name || '未命名相册'}
              cover={album.coverUrl ? albumMediaUrl(album.coverUrl) : ''}
              coverAlt="相册"
              subtitle={
                <>
                  <span className="weq-number weq-number-inherit">{album.mediaCount ?? 0}</span>{' '}
                  个媒体
                  {album.desc ? (
                    <>
                      {' · '}
                      <span data-privacy-sensitive>{album.desc}</span>
                    </>
                  ) : null}
                </>
              }
              selected={multi.selected.has(key)}
              onSelect={selection.selectionMode ? () => multi.toggle(key) : undefined}
              onOpen={() => onOpen(album)}
              selectionProps={multi.itemProps(key)}
            />
          );
        })}
        {multi.box ? <div className="weq-message-marquee" aria-hidden style={multi.box} /> : null}
      </div>
    </div>
  );
}

export function MediaView({
  active = true,
  embedded = false,
  photos,
  total,
  loading,
  loadingMore,
  error,
  hasMore,
  fetchedPages,
  albumName,
  hostUin,
  selfUin,
  topicId,
  onBack,
  onJumpToAlbum,
  onLoadMore,
}: {
  active?: boolean;
  embedded?: boolean;
  photos: QzoneAlbumPhotoWire[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  fetchedPages: number;
  albumName: string;
  hostUin: string;
  selfUin: string;
  topicId: string;
  onBack: () => void;
  onJumpToAlbum?: () => void;
  onLoadMore: () => Promise<boolean>;
}): ReactElement {
  const photoReferences = useMemo(
    () =>
      new Map<string, ContentReference>(
        photos.map((photo) => {
          const ref: ContentReference = {
            kind: 'qzone-photo',
            uin: hostUin,
            albumId: topicId,
            mediaKey: photoKey(photo),
            name: photo.name || albumName,
          };
          return [contentReferenceKey(ref), ref];
        }),
      ),
    [photos, hostUin, topicId, albumName],
  );
  const photoOwner = { kind: 'qzone-albums' as const, container: hostUin };
  const sharedSelection = useContentMultiSelect(
    photoOwner,
    active && !onJumpToAlbum,
    photoReferences,
  );
  const localToReference = useMemo(
    () =>
      new Map(
        photos.map((photo) => [
          photoKey(photo),
          contentReferenceKey({
            kind: 'qzone-photo',
            uin: hostUin,
            albumId: topicId,
            mediaKey: photoKey(photo),
          }),
        ]),
      ),
    [photos, hostUin, topicId],
  );
  const selected = useMemo(
    () =>
      new Set(
        [...localToReference]
          .filter(([, id]) => sharedSelection.selectedIds.has(id))
          .map(([key]) => key),
      ),
    [localToReference, sharedSelection.selectedIds],
  );
  const setSelected = useCallback(
    (value: SetStateAction<Set<string>>) => {
      sharedSelection.setSelectedIds((previous) => {
        const current = new Set(
          [...localToReference].filter(([, id]) => previous.has(id)).map(([key]) => key),
        );
        const next = typeof value === 'function' ? value(current) : value;
        const result = new Set(previous);
        for (const [key, id] of localToReference) {
          if (next.has(key)) result.add(id);
          else result.delete(id);
        }
        return result;
      });
    },
    [sharedSelection.setSelectedIds, localToReference],
  );
  const ids = useMemo(() => [...localToReference.keys()], [localToReference]);
  const [preview, setPreview] = useState<number | null>(null);
  const photoMulti = useAlbumGridSelection({
    ids,
    selected,
    onChange: setSelected,
    selectionMode: !onJumpToAlbum && sharedSelection.selectionMode,
    setSelectionMode: sharedSelection.setSelectionMode,
    marqueeEnabled: active && !onJumpToAlbum && preview === null && !loading && photos.length > 0,
  });

  /** 勾选的媒体行键集合（全选作用于已加载的条目）。
   *
   * 注意不能用裸 `photo.id` 当键：cgi 返回的 id 全是占位 4294967295（真正的定位键
   * 是 lloc/sloc），同一相册所有行共享同一个 id，拿它做选择键会「点一个=全选」。
   * 这里与 React key 一致，使用媒体定位信息，刷新插入新照片后也不会错选。 */
  const toggleSelect = (key: string) => photoMulti.toggle(key);
  const handlers = onJumpToAlbum ? undefined : photoMulti.itemProps;
  const rootProps = onJumpToAlbum ? undefined : photoMulti.rootProps;
  /** 正在取 mp4 播放地址的视频行键（同上，不能裸用 photo.id）。 */
  const [videoResolving, setVideoResolving] = useState<string | null>(null);
  const [details, setDetails] = useState<
    Record<string, { name: string; width: number | null; height: number | null }>
  >({});
  const { run: runDetail, cancel: cancelDetail } = useQzoneRequests();
  const detailEpoch = useRef(0);
  useEffect(() => {
    if (!active) {
      cancelDetail();
      setPreview(null);
    }
    return () => {
      detailEpoch.current++;
      cancelDetail();
    };
  }, [active, cancelDetail]);
  /** 上一页加载失败：哨兵停止自动触发，底部显示「点击重试」。 */
  const [loadFailed, setLoadFailed] = useState(false);

  // 哨兵防抖锁：IntersectionObserver 回调持旧闭包，同一帧内重复触发时用同步
  // ref 挡掉第二次，等本次 loadMore 落定后再放开。
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const videos = photos.filter((p) => p.isVideo).length;
  const imgs = photos.length - videos;
  const countText = !videos
    ? `${imgs} 张`
    : !imgs
      ? `${videos} 个视频`
      : `${imgs} 张 · ${videos} 个视频`;

  /** 触发翻页：先清失败态，await 完才放开锁（同步防抖，挡同一帧重复触发）。 */
  const triggerLoadMore = useCallback(async (): Promise<void> => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadFailed(false);
    try {
      const ok = await onLoadMore();
      if (!ok) setLoadFailed(true);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [onLoadMore]);

  // 滚动到底部自动加载下一页（不再有「加载更多」按钮）。
  useEffect(() => {
    const el = sentinelRef.current;
    if (!active || !el || !hasMore || loadFailed) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        void triggerLoadMore();
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, hasMore, loadFailed, triggerLoadMore]);

  /** 行内唯一选择键（与渲染 React key 一致）。 */
  const rowKey = (index: number): string => photoKey(photos[index]!);

  const previewItems = useMemo<PreviewMedia[]>(
    () =>
      photos.map((photo) => ({
        key: photoKey(photo),
        kind: photo.isVideo ? 'video' : 'image',
        src: albumMediaUrl(photo.url || photo.thumbUrl),
        poster: albumMediaUrl(photo.thumbUrl || photo.url),
        title: photo.name,
        progressTarget: albumMediaTransferTarget(hostUin, topicId, photoKey(photo)),
        load: photo.picKey
          ? async () => {
              cancelDetail();
              const epoch = ++detailEpoch.current;
              const row = photoKey(photo);
              setVideoResolving(row);
              try {
                const detail = await runDetail((requestId) =>
                  client.account.qzone.albumDetail.query({
                    selfUin,
                    hostUin,
                    topicId,
                    picKey: photo.picKey,
                    requestId,
                  }),
                );
                if (epoch === detailEpoch.current)
                  setDetails((current) => ({ ...current, [row]: detail }));
                if (photo.isVideo && !detail.videoUrl) throw new Error('此视频暂无可播放地址。');
                return {
                  src: albumMediaUrl(
                    photo.isVideo
                      ? detail.videoUrl
                      : detail.imageUrl || photo.url || photo.thumbUrl,
                  ),
                  kind: photo.isVideo ? ('video' as const) : ('image' as const),
                };
              } finally {
                if (epoch === detailEpoch.current) setVideoResolving(null);
              }
            }
          : undefined,
      })),
    [photos, selfUin, hostUin, topicId, runDetail, cancelDetail],
  );

  const [preparedVideo, setPreparedVideo] = useState<{ key: string; src: string }>();
  function openMedia(photo: QzoneAlbumPhotoWire, src?: string): void {
    setPreparedVideo(src ? { key: photoKey(photo), src } : undefined);
    setPreview(photos.indexOf(photo));
  }
  const toolbar = onJumpToAlbum ? null : (
    <ContentReferenceToolbar
      owner={photoOwner}
      selection={sharedSelection}
      loaded={[...photoReferences.keys()]}
    />
  );

  return (
    <div className="weq-qzal-media-view">
      {preview !== null ? (
        <MediaPreview
          items={
            preparedVideo
              ? previewItems.map((item) =>
                  item.key === preparedVideo.key
                    ? { ...item, src: preparedVideo.src, load: undefined }
                    : item,
                )
              : previewItems
          }
          initialIndex={preview}
          onClose={() => {
            setPreview(null);
            detailEpoch.current++;
            cancelDetail();
          }}
        />
      ) : null}
      <div ref={observeCompactToolbar} className="weq-qzal-toolbar">
        {onJumpToAlbum ? (
          <button type="button" className="weq-qzal-back" onClick={onJumpToAlbum}>
            跳转到相册
          </button>
        ) : embedded ? (
          <button type="button" title="返回相册列表" aria-label="返回相册列表" onClick={onBack}>
            <ArrowLeft size={17} aria-hidden />
          </button>
        ) : (
          <button title="返回相册" type="button" className="weq-qzal-back" onClick={onBack}>
            <ArrowLeft size={17} aria-hidden />
            <ToolbarLabel>返回相册</ToolbarLabel>
          </button>
        )}
        <span className="weq-qzal-count">
          {onJumpToAlbum ? null : `${albumName || (embedded ? '未命名相册' : '')} · `}
          <NumericText>{countText}</NumericText>
          {total > photos.length ? <NumericText>{` · 共 ${total} 项`}</NumericText> : ''}
        </span>
        {onJumpToAlbum ? null : <QzoneBatchProgress owner={hostUin} />}
        {embedded && (photos.length > 0 || sharedSelection.selectionMode) ? toolbar : null}
      </div>
      {embedded ? null : toolbar}
      {error ? (
        <div className="weq-qzal-empty is-error" role="alert">
          <Inbox size={26} />
          <span>媒体加载失败</span>
          <small>{error}</small>
        </div>
      ) : null}
      {loading ? (
        <MediaGridSkeleton />
      ) : photos.length === 0 && !error ? (
        <div className="weq-qzal-empty">
          <Inbox size={26} />
          <span>这个相册是空的</span>
        </div>
      ) : photos.length > 0 ? (
        <>
          <div className={`weq-qzal-media-grid ${photoMulti.className}`} {...rootProps}>
            {photos.map((photo, index) => {
              const row = rowKey(index);
              const checked = !onJumpToAlbum && photoMulti.selected.has(row);
              const detail = details[row];
              return (
                <div
                  key={row}
                  className={`weq-qzal-media-card${photo.isVideo ? ' is-video' : ''}${checked ? ' is-checked' : ''}`}
                  {...handlers?.(row)}
                >
                  {!onJumpToAlbum && sharedSelection.selectionMode ? (
                    <button
                      type="button"
                      className={`weq-qzal-media-check${checked ? ' is-on' : ''}`}
                      onClick={() => toggleSelect(row)}
                      title={checked ? '取消选择' : '选择'}
                      aria-pressed={checked}
                      aria-label={checked ? '取消选择' : '选择'}
                    >
                      {checked ? <Check size={12} strokeWidth={2.6} /> : null}
                    </button>
                  ) : null}
                  <QzoneAlbumMediaButton
                    photo={photo}
                    onOpen={(src) => openMedia(photo, src)}
                    prepareVideo={photo.isVideo ? previewItems[index]?.load : undefined}
                    indicator={
                      <>
                        <MediaTransferBadge
                          target={albumMediaTransferTarget(hostUin, topicId, row)}
                        />
                        {photo.isVideo ? (
                          <span className="weq-qzal-media-play" aria-hidden>
                            {videoResolving === row ? (
                              <TransferRing
                                progress={{ phase: 'preparing' }}
                                label="正在读取视频"
                                size={16}
                              />
                            ) : (
                              <Play size={18} />
                            )}
                          </span>
                        ) : null}
                      </>
                    }
                    caption={
                      <span className="weq-qzal-media-caption">
                        <span className="weq-qzal-media-name">
                          {detail?.name || photo.name || '未命名'}
                        </span>
                        {detail?.width && detail.height ? (
                          <small>
                            <span className="weq-number weq-number-inherit">{detail.width}</span> ×{' '}
                            <span className="weq-number weq-number-inherit">{detail.height}</span>
                          </small>
                        ) : null}
                        <QzoneTime value={photo.uploadTime} interactive={false} />
                      </span>
                    }
                  />
                </div>
              );
            })}
            {photoMulti.box ? (
              <div className="weq-message-marquee" aria-hidden style={photoMulti.box} />
            ) : null}
          </div>
          <div ref={sentinelRef} className="weq-qzal-sentinel">
            {loadFailed ? (
              <QzonePageButton label="重试加载媒体" retry onClick={() => void triggerLoadMore()} />
            ) : loadingMore ? (
              <span className="weq-qzal-sentinel-text">
                <Loader2 size={13} className="weq-spin" />
                加载中…
                <NumericText>{`（已获取 ${fetchedPages} 页）`}</NumericText>
              </span>
            ) : null}
          </div>
          {!hasMore ? (
            <div className="weq-qzal-end">
              已加载全部 <span className="weq-number weq-number-inherit">{photos.length}</span>{' '}
              项媒体
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

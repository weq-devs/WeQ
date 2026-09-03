/**
 * QzoneAlbumDialog — 左栏「更多功能 → 空间相册」查看器（大灯箱卡片）。
 *
 * 读取自己的 QQ 空间相册（走 qzone web cgi，需要在线 QQ —— p_skey 可由
 * pt_login 本地快速登录兜底，无需注入）。未登录 / 完全离线时给出回退说明文案。
 *
 * 展示逻辑：
 *   - 只有一个相册 → 直接平铺该相册内的全部媒体（照片 + 视频封面，带名称/时间）；
 *   - 多个相册 → 相册卡片（封面 + 名称 + 媒体数），点击进入内部媒体列表。
 *
 * 媒体列表走分页（pageStart/pageNum），底部「加载更多」翻页。图片一律经自定义
 * 资源协议 `weq-media://album?src=…`（主进程代取 + 白名单域名校验）渲染，
 * 不用裸 `<img src=远端>`；相册媒体 cgi 只给视频封面（不给本体 mp4），所以视频
 * 条目以封面 + 播放角标展示，点击看大图。加载态用 skeleton + shimmer 占位。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Images, Inbox, Play, X } from 'lucide-react';
import { Modal } from './Dialog';
import { client } from '../trpc/client';
import { albumMediaUrl } from '../lib/resourceUrl';
import { openLightbox } from './ImageLightbox';
import { useDebouncedLoading } from '../hooks/useDebouncedLoading';

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
  width: number;
  height: number;
}

const PAGE_NUM = 30;

/** 秒级时间戳 → `YYYY-MM-DD`（媒体格子的日期角标）。 */
function fmtDay(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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

export function QzoneAlbumDialog({
  open,
  onClose,
  hostUin,
}: {
  open: boolean;
  onClose: () => void;
  /** 当前账号的 QQ 号（自己空间的相册）。 */
  hostUin: string;
}): ReactElement | null {
  const [access, setAccess] = useState<{
    qqOnline: boolean;
    injectEnabled: boolean;
  } | null>(null);
  const [albums, setAlbums] = useState<QzoneAlbumWire[] | null>(null);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [albumsError, setAlbumsError] = useState<string | null>(null);
  /** 选中的相册：null = 相册列表页。 */
  const [selected, setSelected] = useState<QzoneAlbumWire | null>(null);
  const [media, setMedia] = useState<QzoneAlbumPhotoWire[]>([]);
  const [mediaTotal, setMediaTotal] = useState(0);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaLoadingMore, setMediaLoadingMore] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const runRef = useRef(0);

  /** 打开某相册：拉第一页媒体。 */
  const openAlbum = useCallback(
    (album: QzoneAlbumWire) => {
      const run = ++runRef.current;
      setSelected(album);
      setMedia([]);
      setMediaTotal(0);
      setMediaError(null);
      setMediaLoading(true);
      void client.account.qzoneAlbumMedia
        .query({ hostUin, topicId: album.id, pageStart: 0, pageNum: PAGE_NUM })
        .then((res) => {
          if (run !== runRef.current) return;
          const page = res as { photos: QzoneAlbumPhotoWire[]; totalInAlbum: number } | null;
          setMedia(page?.photos ?? []);
          setMediaTotal(Number(page?.totalInAlbum ?? 0));
        })
        .catch((e: unknown) => {
          if (run !== runRef.current) return;
          setMediaError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (run !== runRef.current) return;
          setMediaLoading(false);
        });
    },
    [hostUin],
  );

  // 打开时：先探在线状态，再拉相册列表。
  useEffect(() => {
    if (!open) return;
    const run = ++runRef.current;
    setAccess(null);
    setAlbums(null);
    setSelected(null);
    setMedia([]);
    setMediaTotal(0);
    setMediaLoading(false);
    setMediaLoadingMore(false);
    setMediaError(null);
    setAlbumsError(null);
    setAlbumsLoading(true);
    void client.account.getGroupAlbumAccessState
      .query()
      .then((state) => {
        if (run !== runRef.current) return;
        setAccess({ qqOnline: state.qqOnline, injectEnabled: state.injectEnabled });
      })
      .catch(() => {
        if (run !== runRef.current) return;
        setAccess({ qqOnline: false, injectEnabled: true });
      })
      .finally(() => {
        if (run !== runRef.current) return;
        setAlbumsLoading(false);
      });
    return () => {
      runRef.current += 1;
    };
  }, [open, hostUin]);

  // 在线状态落定后拉相册列表。
  useEffect(() => {
    if (!open || !access?.qqOnline) return;
    const run = ++runRef.current;
    setAlbumsLoading(true);
    setAlbumsError(null);
    void client.account.qzoneAlbumList
      .query({ hostUin })
      .then((rows) => {
        if (run !== runRef.current) return;
        const list = (rows as QzoneAlbumWire[] | null) ?? [];
        setAlbums(list);
        setAlbumsLoading(false);
      })
      .catch((e: unknown) => {
        if (run !== runRef.current) return;
        setAlbumsError(e instanceof Error ? e.message : String(e));
        setAlbumsLoading(false);
      });
    return () => {
      runRef.current += 1;
    };
  }, [open, hostUin, access?.qqOnline]);

  // 只有一个相册 → 自动平铺它的媒体（打开 + 相册落定后触发一次）。
  useEffect(() => {
    if (!open || !albums || albums.length !== 1 || selected) return;
    void openAlbum(albums[0]!);
  }, [open, albums, selected, openAlbum]);

  /** 翻页：pageStart = 已加载条数。 */
  const loadMore = useCallback(async () => {
    if (!selected || mediaLoading || mediaLoadingMore) return;
    const run = runRef.current;
    setMediaLoadingMore(true);
    try {
      const res = (await client.account.qzoneAlbumMedia.query({
        hostUin,
        topicId: selected.id,
        pageStart: media.length,
        pageNum: PAGE_NUM,
      })) as { photos: QzoneAlbumPhotoWire[]; totalInAlbum: number } | null;
      if (run !== runRef.current) return;
      const photos = res?.photos ?? [];
      setMedia((prev) => [...prev, ...photos]);
      setMediaTotal(Number(res?.totalInAlbum ?? media.length + photos.length));
    } catch (_e) {
      // 单页失败静默，用户可再点「加载更多」。
    } finally {
      if (run === runRef.current) setMediaLoadingMore(false);
    }
  }, [selected, media.length, mediaLoading, mediaLoadingMore, hostUin]);

  const backToList = useCallback(() => {
    setSelected(null);
    setMedia([]);
    setMediaTotal(0);
    setMediaError(null);
  }, []);

  if (!open) return null;

  const offline = access ? !access.qqOnline : false;
  const offlineMode = access ? !access.injectEnabled : false;
  const hasMore = selected ? media.length < mediaTotal : false;

  return (
    <Modal onClose={onClose} width={1080} labelledBy="weq-qzone-album-title">
      <div className="weq-qzone-album">
        <header className="weq-qzone-album-head">
          <span className="weq-qzone-album-title">
            <span className="weq-qzone-album-title-icon" aria-hidden="true">
              <Images size={16} strokeWidth={2} />
            </span>
            <strong id="weq-qzone-album-title">
              {selected ? selected.name || '相册' : '空间相册'}
            </strong>
          </span>
          <button type="button" className="weq-compose-x" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        </header>

        <div className="weq-qzone-album-body">
          {access === null ? (
            <div className="weq-qzone-album-empty">
              <Inbox size={26} />
              <span>检查在线状态…</span>
            </div>
          ) : offline ? (
            <div className="weq-qzone-album-empty weq-qzone-album-offline">
              <Inbox size={26} />
              <span>{offlineMode ? '完全离线模式已开启' : '需要登录 QQ 客户端'}</span>
              <small>
                {offlineMode
                  ? '已关闭「自动注入 QQ（完整功能）」，空间相册需要在线 QQ 实例的 pskey 凭证才能访问。请在设置中开启后重试。'
                  : '空间相册需要当前账号的 QQ 客户端在线以获取访问凭证（pskey）。请打开并登录 QQ 后重试。'}
              </small>
            </div>
          ) : albumsLoading ? (
            <AlbumListSkeleton />
          ) : albumsError ? (
            <div className="weq-qzone-album-empty is-error">
              <Inbox size={26} />
              <span>相册列表加载失败</span>
              <small>{albumsError}</small>
            </div>
          ) : selected ? (
            <MediaView
              photos={media}
              total={mediaTotal}
              loading={mediaLoading}
              loadingMore={mediaLoadingMore}
              error={mediaError}
              hasMore={hasMore}
              albumName={selected.name}
              onBack={backToList}
              onLoadMore={() => void loadMore()}
            />
          ) : !albums || albums.length === 0 ? (
            <div className="weq-qzone-album-empty">
              <Inbox size={26} />
              <span>这个空间还没有相册</span>
              <small>QQ 空间里创建相册后，这里会自动出现。</small>
            </div>
          ) : (
            <AlbumGridView albums={albums} onOpen={(album) => void openAlbum(album)} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function AlbumGridView({
  albums,
  onOpen,
}: {
  albums: QzoneAlbumWire[];
  onOpen: (album: QzoneAlbumWire) => void;
}): ReactElement {
  return (
    <div className="weq-qzal-album-grid">
      {albums.map((album) => (
        <button
          key={album.id}
          type="button"
          className="weq-qzal-album-card"
          onClick={() => onOpen(album)}
          title={album.name || '未命名相册'}
        >
          <span className="weq-qzal-album-cover">
            {album.coverUrl ? (
              <img
                src={albumMediaUrl(album.coverUrl)}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="weq-qzal-album-cover-empty">
                <Images size={22} />
              </span>
            )}
          </span>
          <span className="weq-qzal-album-meta">
            <strong>{album.name || '未命名相册'}</strong>
            <small>
              {album.mediaCount ?? 0} 个媒体
              {album.desc ? ` · ${album.desc}` : ''}
            </small>
          </span>
        </button>
      ))}
    </div>
  );
}

function MediaView({
  photos,
  total,
  loading,
  loadingMore,
  error,
  hasMore,
  albumName,
  onBack,
  onLoadMore,
}: {
  photos: QzoneAlbumPhotoWire[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  albumName: string;
  onBack: () => void;
  onLoadMore: () => void;
}): ReactElement {
  const videos = photos.filter((p) => p.isVideo).length;
  const imgs = photos.length - videos;
  const countText = !videos
    ? `${imgs} 张`
    : !imgs
      ? `${videos} 个视频`
      : `${imgs} 张 · ${videos} 个视频`;
  return (
    <div className="weq-qzal-media-view">
      <div className="weq-qzal-toolbar">
        <button type="button" className="weq-qzal-back" onClick={onBack}>
          返回相册
        </button>
        <span className="weq-qzal-count">
          {albumName} · {countText}
          {total > photos.length ? ` · 共 ${total} 项` : ''}
        </span>
      </div>
      {loading ? (
        <MediaGridSkeleton />
      ) : error ? (
        <div className="weq-qzal-empty is-error">
          <Inbox size={26} />
          <span>媒体加载失败</span>
          <small>{error}</small>
        </div>
      ) : photos.length === 0 ? (
        <div className="weq-qzal-empty">
          <Inbox size={26} />
          <span>这个相册是空的</span>
        </div>
      ) : (
        <>
          <div className="weq-qzal-media-grid">
            {photos.map((photo, index) => {
              const proxied = albumMediaUrl(photo.url || photo.thumbUrl);
              return (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: 媒体列表按位置渲染，无稳定唯一键
                  key={`${photo.id}:${index}`}
                  type="button"
                  className={`weq-qzal-media-card${photo.isVideo ? ' is-video' : ''}`}
                  onClick={() => openLightbox(proxied, photo.name || '空间相册媒体')}
                >
                  <img src={proxied} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  {photo.isVideo ? (
                    <span className="weq-qzal-media-play" aria-hidden>
                      <Play size={18} />
                    </span>
                  ) : null}
                  <span className="weq-qzal-media-caption">
                    <span className="weq-qzal-media-name">{photo.name || '未命名'}</span>
                    {photo.uploadTime ? <time>{fmtDay(photo.uploadTime)}</time> : null}
                  </span>
                </button>
              );
            })}
          </div>
          {hasMore ? (
            <div className="weq-qzal-loadmore">
              <button
                type="button"
                className="weq-qzal-loadmore-btn"
                onClick={onLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? '加载中…' : '加载更多'}
              </button>
            </div>
          ) : photos.length > 0 ? (
            <div className="weq-qzal-end">已加载全部 {photos.length} 项媒体</div>
          ) : null}
        </>
      )}
    </div>
  );
}

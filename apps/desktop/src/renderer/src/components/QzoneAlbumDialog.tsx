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
 * 媒体列表走分页（pageStart/pageNum），滚动到底部自动加载下一页（哨兵 + 防抖），
 * 不再有「加载更多」按钮。图片一律经自定义资源协议 `weq-media://album?src=…`
 * （主进程代取 + 白名单域名校验）渲染，不用裸 `<img src=远端>`；视频条目点封面
 * 会按 picKey 现取本体 mp4（cgi_floatview_photo_list_v2，列表 cgi 只给封面）后
 * 直接进视频灯箱播放。支持勾选 / 全选后并发下载保存（复用主进程的相册媒体
 * 下载工具函数）。加载态用 skeleton + shimmer 占位。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Check, Download, Images, Inbox, Loader2, Play, X } from 'lucide-react';
import { Modal, useDialog } from './Dialog';
import { client } from '../trpc/client';
import { albumMediaUrl } from '../lib/resourceUrl';
import { openLightbox } from './ImageLightbox';
import { openVideoLightbox } from './VideoLightbox';
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
  /** 视频取 mp4 本体的定位键（lloc/sloc）。 */
  picKey: string;
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
  /** 与 media 同步的下一页偏移：哨兵回调持旧闭包时也拿得到正确 pageStart。 */
  const mediaLenRef = useRef(0);

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
          const photos = page?.photos ?? [];
          mediaLenRef.current = photos.length;
          setMedia(photos);
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

  /** 翻页：pageStart = 已加载条数。返回是否成功（哨兵据此决定是否自动重试）。 */
  const loadMore = useCallback(async (): Promise<boolean> => {
    if (!selected || mediaLoading || mediaLoadingMore) return true;
    const run = runRef.current;
    setMediaLoadingMore(true);
    try {
      const res = (await client.account.qzoneAlbumMedia.query({
        hostUin,
        topicId: selected.id,
        pageStart: mediaLenRef.current,
        pageNum: PAGE_NUM,
      })) as { photos: QzoneAlbumPhotoWire[]; totalInAlbum: number } | null;
      if (run !== runRef.current) return true;
      const photos = res?.photos ?? [];
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
  }, [selected, mediaLoading, mediaLoadingMore, hostUin]);

  const backToList = useCallback(() => {
    mediaLenRef.current = 0;
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
              hostUin={hostUin}
              topicId={selected.id}
              onBack={backToList}
              onLoadMore={() => loadMore()}
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
  hostUin,
  topicId,
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
  hostUin: string;
  topicId: string;
  onBack: () => void;
  onLoadMore: () => Promise<boolean>;
}): ReactElement {
  const showError = useDialog((s) => s.showError);
  const showInfo = useDialog((s) => s.showInfo);

  /** 勾选的媒体行键集合（全选作用于已加载的条目）。
   *
   * 注意不能用裸 `photo.id` 当键：cgi 返回的 id 全是占位 4294967295（真正的定位键
   * 是 lloc/sloc），同一相册所有行共享同一个 id，拿它做选择键会「点一个=全选」。
   * 这里与下方渲染的 React key 保持一致，用 `id:index` 行内唯一键。 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 正在取 mp4 播放地址的视频行键（同上，不能裸用 photo.id）。 */
  const [videoResolving, setVideoResolving] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
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
    if (!el || !hasMore || loadFailed) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        void triggerLoadMore();
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadFailed, triggerLoadMore]);

  /** 行内唯一选择键（与渲染 React key 一致）。 */
  const rowKey = (index: number): string => `${photos[index]!.id}:${index}`;

  const toggleSelect = (row: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });
  };

  const allSelected = photos.length > 0 && photos.every((_, i) => selected.has(rowKey(i)));
  const toggleSelectAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(photos.map((_, i) => rowKey(i))));
  };

  /** 点视频封面：按 picKey 现取本体 mp4 进视频灯箱；取不到回退大图。 */
  async function openMedia(photo: QzoneAlbumPhotoWire, row: string): Promise<void> {
    const proxied = albumMediaUrl(photo.url || photo.thumbUrl);
    if (!photo.isVideo) {
      openLightbox(proxied, photo.name || '空间相册媒体');
      return;
    }
    if (!photo.picKey) {
      openLightbox(proxied, photo.name || '空间相册媒体');
      return;
    }
    setVideoResolving(row);
    try {
      const mp4 = await client.account.qzoneAlbumVideoUrl.query({
        hostUin,
        topicId,
        picKey: photo.picKey,
      });
      // TEMP-DEBUG：排查个别视频播不了，复现后把这段日志贴回来即可删除。
      console.warn('[qzal-video-debug] 解析 mp4', {
        row,
        name: photo.name,
        rawId: photo.id,
        isVideo: photo.isVideo,
        picKey: photo.picKey,
        thumbUrl: photo.thumbUrl,
        mp4: mp4 || '(空)',
        lightboxSrc: mp4 ? albumMediaUrl(mp4) : '(回退封面)',
      });
      if (mp4) {
        openVideoLightbox(albumMediaUrl(mp4), albumMediaUrl(photo.thumbUrl || photo.url));
      } else {
        // 只有 m3u8 之类取不到可播 mp4 时回退封面大图。
        openLightbox(proxied, photo.name || '空间相册媒体');
      }
    } catch (e) {
      showError('视频打开失败', e instanceof Error ? e.message : String(e));
    } finally {
      setVideoResolving(null);
    }
  }

  /** 勾选媒体并发下载保存：先选文件夹，再由主进程并发拉取落盘。 */
  async function downloadSelected(): Promise<void> {
    const items = photos.filter((_, i) => selected.has(rowKey(i)));
    if (items.length === 0) return;
    setDownloading(true);
    try {
      const outputDir = await client.account.pickQzoneAlbumExportDir.mutate();
      if (!outputDir) return;
      const res = await client.account.exportQzoneAlbumMedia.mutate({
        hostUin,
        topicId,
        outputDir,
        concurrency: 4,
        items: items.map((p) => ({
          id: p.id,
          name: p.name,
          url: p.url || p.thumbUrl,
          isVideo: p.isVideo,
          picKey: p.picKey,
        })),
      });
      if (res.failed.length === 0) {
        setSelected(new Set());
        showInfo('下载完成', `已保存 ${res.ok} 个文件到：${res.outputDir}`);
      } else {
        setSelected(new Set());
        showError(
          '部分媒体下载失败',
          `成功 ${res.ok} 个，失败 ${res.failed.length} 个。${res.failed[0]?.fileName ?? ''}${res.failed[0]?.error ? `：${res.failed[0].error}` : ''}`,
        );
      }
    } catch (e) {
      showError('下载失败', e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

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
      {photos.length > 0 ? (
        <div className="weq-qzal-selectbar">
          <button
            type="button"
            className={`weq-qzal-select-all${allSelected ? ' is-on' : ''}`}
            onClick={toggleSelectAll}
            disabled={downloading}
          >
            <span className="weq-qzal-check" aria-hidden>
              {allSelected ? <Check size={12} strokeWidth={2.6} /> : null}
            </span>
            {allSelected ? '取消全选' : '全选'}
          </button>
          <span className="weq-qzal-select-count">已选 {selected.size} 项</span>
          <button
            type="button"
            className="weq-qzal-download"
            disabled={selected.size === 0 || downloading}
            onClick={() => void downloadSelected()}
          >
            {downloading ? (
              <Loader2 size={13} strokeWidth={2.2} className="weq-spin" />
            ) : (
              <Download size={13} strokeWidth={2.2} />
            )}
            {downloading ? '下载中…' : '下载选中'}
          </button>
        </div>
      ) : null}
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
              const row = rowKey(index);
              const proxied = albumMediaUrl(photo.url || photo.thumbUrl);
              const checked = selected.has(row);
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: 媒体列表按位置渲染，无稳定唯一键
                  key={`${photo.id}:${index}`}
                  className={`weq-qzal-media-card${photo.isVideo ? ' is-video' : ''}${checked ? ' is-checked' : ''}`}
                >
                  <button
                    type="button"
                    className={`weq-qzal-media-check${checked ? ' is-on' : ''}`}
                    onClick={() => toggleSelect(row)}
                    disabled={downloading}
                    title={checked ? '取消选择' : '选择'}
                    aria-pressed={checked}
                    aria-label={checked ? '取消选择' : '选择'}
                  >
                    {checked ? <Check size={12} strokeWidth={2.6} /> : null}
                  </button>
                  <button
                    type="button"
                    className="weq-qzal-media-body"
                    onClick={() => void openMedia(photo, row)}
                  >
                    <span className="weq-qzal-media-thumb">
                      <img src={proxied} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      {photo.isVideo ? (
                        <span className="weq-qzal-media-play" aria-hidden>
                          {videoResolving === row ? (
                            <Loader2 size={16} className="weq-spin" />
                          ) : (
                            <Play size={18} />
                          )}
                        </span>
                      ) : null}
                    </span>
                    <span className="weq-qzal-media-caption">
                      <span className="weq-qzal-media-name">{photo.name || '未命名'}</span>
                      {photo.uploadTime ? <time>{fmtDay(photo.uploadTime)}</time> : null}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          <div ref={sentinelRef} className="weq-qzal-sentinel">
            {loadFailed ? (
              <button
                type="button"
                className="weq-qzal-retry"
                onClick={() => void triggerLoadMore()}
              >
                加载失败，点击重试
              </button>
            ) : loadingMore ? (
              <span className="weq-qzal-sentinel-text">
                <Loader2 size={13} className="weq-spin" />
                加载中…
              </span>
            ) : null}
          </div>
          {!hasMore ? <div className="weq-qzal-end">已加载全部 {photos.length} 项媒体</div> : null}
        </>
      )}
    </div>
  );
}

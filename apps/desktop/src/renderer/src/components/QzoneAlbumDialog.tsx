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
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { Check, Download, Images, Inbox, Loader2, Play, X } from 'lucide-react';
import { Modal, useDialog } from './Dialog';
import type { QzoneAlbumRequest } from '../lib/qzoneNavigation';
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

/** Native placeholder IDs are not unique; keep selections tied to the actual media. */
function photoKey(photo: QzoneAlbumPhotoWire): string {
  return (
    photo.picKey || photo.url || photo.thumbUrl || `${photo.id}:${photo.uploadTime}:${photo.name}`
  );
}

/** Use stable keys as the range anchor so prepended/removed media cannot shift it. */
function useAlbumSelection(keys: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const pointerSelection = useRef<string | null>(null);
  const toggle = (key: string, range = false): void => {
    const start = anchor.current ? keys.indexOf(anchor.current) : -1;
    const end = keys.indexOf(key);
    setSelected((previous) => {
      const next = new Set(previous);
      const selecting = !next.has(key);
      const targets =
        range && start >= 0 && end >= 0
          ? keys.slice(Math.min(start, end), Math.max(start, end) + 1)
          : [key];
      for (const target of targets) {
        if (selecting) next.add(target);
        else next.delete(target);
      }
      return next;
    });
    if (!range || start < 0) anchor.current = key;
  };
  const modified = (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean =>
    event.ctrlKey || event.metaKey || event.shiftKey;
  const handlers = (key: string, disabled: boolean) => ({
    onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
      pointerSelection.current = null;
      if (event.button !== 0 || !modified(event)) return;
      pointerSelection.current = key;
      event.preventDefault();
      event.stopPropagation();
      if (!disabled) toggle(key, event.shiftKey);
    },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      const handledPointer = pointerSelection.current === key;
      pointerSelection.current = null;
      if (!handledPointer && !modified(event)) return;
      event.preventDefault();
      event.stopPropagation();
      // Also swallow the click if the modifier was released after pointerdown.
      if (!handledPointer && !disabled) toggle(key, event.shiftKey);
    },
    onContextMenuCapture: (event: MouseEvent<HTMLDivElement>) => {
      if (event.ctrlKey) event.preventDefault();
    },
  });
  return { selected, setSelected, toggle, handlers };
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
  embedded = false,
  active = true,
  refreshKey = 0,
  albumTarget,
}: {
  open: boolean;
  onClose: () => void;
  /** 当前账号的 QQ 号（自己空间的相册）。 */
  hostUin: string;
  embedded?: boolean;
  active?: boolean;
  refreshKey?: number;
  albumTarget?: QzoneAlbumRequest;
}): ReactElement | null {
  const [access, setAccess] = useState<{
    qqOnline: boolean;
    attachEnabled: boolean;
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
  const lastRefresh = useRef(refreshKey);
  const [refreshing, setRefreshing] = useState(false);
  /** 与 media 同步的下一页偏移：哨兵回调持旧闭包时也拿得到正确 pageStart。 */
  const mediaLenRef = useRef(0);

  /** 打开某相册：拉第一页媒体。 */
  const openAlbum = useCallback(
    (album: QzoneAlbumWire) => {
      const run = ++runRef.current;
      setSelected(album);
      mediaLenRef.current = 0;
      setMediaLoadingMore(false);
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
        setAccess({ qqOnline: state.qqOnline, attachEnabled: state.attachEnabled });
      })
      .catch(() => {
        if (run !== runRef.current) return;
        setAccess({ qqOnline: false, attachEnabled: true });
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

  const openedTarget = useRef<string | null>(null);
  useEffect(() => {
    if (
      !open ||
      !active ||
      !access?.qqOnline ||
      !albumTarget ||
      albumTarget.hostUin !== hostUin ||
      openedTarget.current === albumTarget.revision ||
      albumsLoading ||
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
    open,
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

  // Re-entering at the latest edge refreshes in place, without resetting selection or media.
  useEffect(() => {
    if (
      !open ||
      !active ||
      refreshKey === lastRefresh.current ||
      !access?.qqOnline ||
      albumsLoading ||
      mediaLoading ||
      mediaLoadingMore
    )
      return;
    lastRefresh.current = refreshKey;
    const run = ++runRef.current;
    let live = true;
    setRefreshing(true);
    setAlbumsError(null);
    void (async () => {
      if (selected) {
        const page = (await client.account.qzoneAlbumMedia.query({
          hostUin,
          topicId: selected.id,
          pageStart: 0,
          pageNum: PAGE_NUM,
        })) as { photos: QzoneAlbumPhotoWire[]; totalInAlbum: number } | null;
        if (!live || run !== runRef.current) return;
        if (!page || !Array.isArray(page.photos)) throw new Error('暂时无法刷新相册，请稍后重试。');
        const fresh = page.photos;
        setMedia((previous) => {
          const keys = new Set(fresh.map(photoKey));
          const merged = [...fresh, ...previous.filter((photo) => !keys.has(photoKey(photo)))];
          mediaLenRef.current = merged.length;
          return merged;
        });
        setMediaTotal(Number(page?.totalInAlbum ?? mediaLenRef.current));
      } else {
        const rows = await client.account.qzoneAlbumList.query({ hostUin });
        if (!Array.isArray(rows)) throw new Error('暂时无法刷新相册，请稍后重试。');
        if (live && run === runRef.current) setAlbums(rows as QzoneAlbumWire[]);
      }
    })()
      .catch((error: unknown) => {
        if (live && run === runRef.current)
          setAlbumsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (live) setRefreshing(false);
      });
    return () => {
      live = false;
      setRefreshing(false);
    };
  }, [
    open,
    active,
    refreshKey,
    access?.qqOnline,
    albumsLoading,
    mediaLoading,
    mediaLoadingMore,
    selected,
    hostUin,
  ]);

  /** 翻页：pageStart = 已加载条数。返回是否成功（哨兵据此决定是否自动重试）。 */
  const loadMore = useCallback(async (): Promise<boolean> => {
    if (!selected || mediaLoading || mediaLoadingMore || refreshing || !active) return true;
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
  }, [selected, mediaLoading, mediaLoadingMore, refreshing, active, hostUin]);

  const backToList = useCallback(() => {
    mediaLenRef.current = 0;
    setSelected(null);
    setMedia([]);
    setMediaTotal(0);
    setMediaError(null);
  }, []);

  if (!open) return null;

  const offline = access ? !access.qqOnline : false;
  const offlineMode = access ? !access.attachEnabled : false;
  const hasMore = selected ? media.length < mediaTotal : false;

  const body = (
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
        {!embedded ? (
          <button type="button" className="weq-compose-x" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        ) : null}
      </header>

      <div className="weq-qzone-album-body">
        {refreshing && albums ? (
          <p className="weq-qzn-loading" role="status">
            <Loader2 size={16} className="weq-spin" />
            正在刷新…
          </p>
        ) : null}
        {albumsError && albums ? <p className="weq-qzn-status">{albumsError}</p> : null}
        {access === null ? (
          <div className="weq-qzone-album-empty">
            <Inbox size={26} />
            <Loader2 size={18} className="weq-spin" />
            <span>检查在线状态…</span>
          </div>
        ) : offline ? (
          <div className="weq-qzone-album-empty weq-qzone-album-offline">
            <Inbox size={26} />
            <span>{offlineMode ? '完全离线模式已开启' : '需要登录 QQ 客户端'}</span>
            <small>
              {offlineMode
                ? '已关闭「自动读取 QQ 内存（完整功能）」，空间相册需要在线 QQ 实例的 pskey 凭证才能访问。请在设置中开启后重试。'
                : '空间相册需要当前账号的 QQ 客户端在线以获取访问凭证（pskey）。请打开并登录 QQ 后重试。'}
            </small>
          </div>
        ) : albumsLoading && !albums ? (
          <AlbumListSkeleton />
        ) : albumsError && !albums && !selected ? (
          <div className="weq-qzone-album-empty is-error">
            <Inbox size={26} />
            <span>相册列表加载失败</span>
            <small>{albumsError}</small>
          </div>
        ) : selected ? (
          <MediaView
            key={`${hostUin}:${selected.id}`}
            active={active}
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
          <AlbumGridView
            albums={albums}
            hostUin={hostUin}
            onOpen={(album) => void openAlbum(album)}
          />
        )}
      </div>
    </div>
  );
  return embedded ? (
    body
  ) : (
    <Modal onClose={onClose} width={1080} labelledBy="weq-qzone-album-title">
      {body}
    </Modal>
  );
}

function AlbumGridView({
  albums,
  hostUin,
  onOpen,
}: {
  albums: QzoneAlbumWire[];
  hostUin: string;
  onOpen: (album: QzoneAlbumWire) => void;
}): ReactElement {
  const {
    selected: checked,
    setSelected: setChecked,
    toggle,
    handlers,
  } = useAlbumSelection(albums.map((album) => album.id));
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [stopping, setStopping] = useState(false);
  const locked = useRef(false);
  const cancelled = useRef(false);
  const active = useRef(true);
  const showInfo = useDialog((s) => s.showInfo);
  const showError = useDialog((s) => s.showError);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      cancelled.current = true;
    };
  }, []);
  const allChecked = albums.length > 0 && albums.every((album) => checked.has(album.id));

  async function exportAlbums(): Promise<void> {
    if (locked.current || checked.size === 0) return;
    locked.current = true;
    cancelled.current = false;
    setExporting(true);
    setStopping(false);
    setProgress('选择保存位置…');
    let saved = 0;
    const failures: string[] = [];
    const completed = new Set<string>();
    try {
      const outputDir = await client.account.pickQzoneAlbumExportDir.mutate();
      if (!outputDir || cancelled.current) {
        if (active.current) setProgress('');
        return;
      }
      const batchRoot = `${outputDir.replace(/[\\/]+$/, '')}/空间相册_${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomUUID().slice(0, 8)}`;
      const targets = albums.filter((album) => checked.has(album.id));
      for (const [index, album] of targets.entries()) {
        if (cancelled.current) break;
        const safe = (value: string): string =>
          value
            .replace(/[<>:"/\\|?*]/g, '_')
            .split('')
            .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? '_' : char))
            .join('')
            .trim()
            .slice(0, 80) || '相册';
        const folder = `${batchRoot}/${safe(album.name)}_${safe(album.id)}`;
        let start = 0,
          pageIndex = 0,
          sequence = 0;
        const seen = new Set<string>();
        let albumFailed = false;
        try {
          while (!cancelled.current) {
            if (++pageIndex > 10000) throw new Error('相册分页未结束，请分批重试。');
            if (active.current)
              setProgress(
                `${index + 1}/${targets.length} · ${album.name || '未命名相册'} · 已保存 ${saved} 个文件`,
              );
            const page = await client.account.qzoneAlbumMedia.query({
              hostUin,
              topicId: album.id,
              pageStart: start,
              pageNum: PAGE_NUM,
            });
            if (cancelled.current) break;
            const photos = (page?.photos ?? []) as QzoneAlbumPhotoWire[];
            if (!photos.length) {
              if (start < Number(page?.totalInAlbum ?? 0))
                throw new Error('相册分页提前返回空页，未导出全部媒体。');
              break;
            }
            const fresh = photos.filter((photo) => {
              const key = `${photo.isVideo}:${photo.picKey || photo.url || photo.thumbUrl}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            if (!fresh.length) throw new Error('相册分页重复，已停止，避免重复下载。');
            const items = fresh
              .filter((photo) => {
                if (photo.url || photo.thumbUrl) return true;
                albumFailed = true;
                failures.push(`${album.name}：有媒体缺少下载地址。`);
                return false;
              })
              .map((photo) => {
                sequence++;
                return {
                  id: photo.id || String(sequence),
                  name: `${String(sequence).padStart(6, '0')}_${photo.name || '媒体'}`,
                  url: photo.url || photo.thumbUrl,
                  isVideo: photo.isVideo,
                  picKey: photo.picKey,
                };
              });
            if (items.length) {
              const result = await client.account.exportQzoneAlbumMedia.mutate({
                hostUin,
                topicId: album.id,
                outputDir: folder,
                concurrency: 4,
                items,
              });
              saved += result.ok;
              if (result.failed.length) {
                albumFailed = true;
                failures.push(
                  `${album.name}：${result.failed.length} 个媒体失败${result.failed[0]?.error ? `（${result.failed[0].error}）` : ''}`,
                );
              }
            }
            start += photos.length;
            const total = Number(page?.totalInAlbum ?? 0);
            if (total > 0 ? start >= total : photos.length < PAGE_NUM) break;
          }
          if (!cancelled.current && !albumFailed) completed.add(album.id);
        } catch (error) {
          failures.push(`${album.name}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!active.current) return;
      setChecked((current) => new Set([...current].filter((id) => !completed.has(id))));
      setProgress(`已保存 ${saved} 个文件${cancelled.current ? ' · 已停止' : ''}`);
      if (failures.length)
        showError('部分相册导出失败', `已保存 ${saved} 个文件。${failures.slice(0, 5).join('；')}`);
      else
        showInfo(
          cancelled.current ? '导出已停止' : '导出完成',
          `已保存 ${saved} 个文件到：${batchRoot}`,
        );
    } catch (error) {
      if (active.current)
        showError('相册导出失败', error instanceof Error ? error.message : String(error));
    } finally {
      locked.current = false;
      if (active.current) {
        setExporting(false);
        setStopping(false);
      }
    }
  }

  return (
    <div className="weq-qzal-album-list">
      <div className="weq-qzal-selectbar">
        <button
          type="button"
          className={`weq-qzal-select-all${allChecked ? ' is-on' : ''}`}
          disabled={exporting}
          onClick={() =>
            setChecked(allChecked ? new Set() : new Set(albums.map((album) => album.id)))
          }
        >
          <span className="weq-qzal-check" aria-hidden>
            {allChecked ? <Check size={12} /> : null}
          </span>
          {allChecked ? '取消全选' : '全选'}
        </button>
        <span className="weq-qzal-select-count">已选 {checked.size} 个相册</span>
        <button
          type="button"
          className="weq-qzal-download"
          disabled={exporting || !checked.size}
          onClick={() => void exportAlbums()}
        >
          {exporting ? <Loader2 size={13} className="weq-spin" /> : <Download size={13} />}
          {exporting ? '导出中…' : '导出选中相册'}
        </button>
        {exporting ? (
          <button
            type="button"
            disabled={stopping}
            onClick={() => {
              cancelled.current = true;
              setStopping(true);
              setProgress('正在停止，等待当前批次完成…');
            }}
          >
            {stopping ? '正在停止…' : '停止'}
          </button>
        ) : null}
      </div>
      {progress ? (
        <p className="weq-qzal-export-progress" role="status">
          {progress}
        </p>
      ) : null}
      <div className="weq-qzal-album-grid">
        {albums.map((album) => (
          <div
            key={album.id}
            className={`weq-qzal-album-card${checked.has(album.id) ? ' is-checked' : ''}`}
            {...handlers(album.id, exporting)}
          >
            <button
              type="button"
              className={`weq-qzal-media-check${checked.has(album.id) ? ' is-on' : ''}`}
              aria-label={`选择相册 ${album.name || '未命名相册'}`}
              aria-pressed={checked.has(album.id)}
              disabled={exporting}
              onClick={() => toggle(album.id)}
            >
              {checked.has(album.id) ? <Check size={12} /> : null}
            </button>
            <button
              type="button"
              className="weq-qzal-album-open"
              disabled={exporting}
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
                  {album.mediaCount ?? 0} 个媒体{album.desc ? ` · ${album.desc}` : ''}
                </small>
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function MediaView({
  active = true,
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
  active?: boolean;
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
   * 这里与 React key 一致，使用媒体定位信息，刷新插入新照片后也不会错选。 */
  const {
    selected,
    setSelected,
    toggle: toggleSelect,
    handlers,
  } = useAlbumSelection(photos.map(photoKey));
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
                  key={row}
                  className={`weq-qzal-media-card${photo.isVideo ? ' is-video' : ''}${checked ? ' is-checked' : ''}`}
                  {...handlers(row, downloading)}
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

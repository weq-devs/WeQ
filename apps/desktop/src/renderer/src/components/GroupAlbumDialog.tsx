import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  ArrowLeft,
  Film,
  Image,
  ImagePlus,
  Images,
  Loader2,
  Play,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../shared/router';
import { client } from '../trpc/client';
import { albumMediaUrl } from '../lib/resourceUrl';
import { QzoneMediaPreview, type QzonePreviewMedia } from './QzoneMediaPreview';
import { MediaSourceSave } from './MediaSaveControls';
import { OverlayLayer } from './OverlayLayer';
import { GroupAlbumMediaActions, GroupAlbumUpload } from './qq-actions/MediaActions';
import { withQQAccountScope } from './qq-actions/shared';
import { useQQReadActivity } from '../hooks/useQQAutoRefresh';
import { readWithRetry } from '../lib/autoRead';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import '../styles/group-album-browser.css';

type AccountOutput = inferRouterOutputs<AppRouter>['account'];
export type GroupAlbumWire = AccountOutput['listGroupAlbums'][number];
type AlbumMediaWire = AccountOutput['listGroupAlbumMedia'][number];

type MediaState =
  | { status: 'idle'; album: GroupAlbumWire | null; items: AlbumMediaWire[]; error: string | null }
  | { status: 'loading'; album: GroupAlbumWire; items: AlbumMediaWire[]; error: string | null }
  | { status: 'ready'; album: GroupAlbumWire; items: AlbumMediaWire[]; error: string | null };

interface GroupAlbumDialogProps {
  groupCode: string;
  groupName: string;
  initialAlbums?: GroupAlbumWire[];
  initialAlbumId?: string;
  binding?: QQWriteBinding;
  onClose: () => void;
}
const ScopedGroupAlbumDialog = withQQAccountScope(GroupAlbumDialogBody);
export function GroupAlbumDialog(props: GroupAlbumDialogProps): ReactElement {
  return <ScopedGroupAlbumDialog key={props.groupCode} {...props} />;
}
function GroupAlbumDialogBody({
  groupCode,
  groupName,
  initialAlbums,
  initialAlbumId,
  binding,
  onClose,
}: GroupAlbumDialogProps): ReactElement {
  const activity = useQQReadActivity(true);
  const alive = useRef(true);
  const run = useRef(0);
  const mediaController = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      run.current++;
      mediaController.current?.abort();
    };
  }, []);
  const [albums, setAlbums] = useState<GroupAlbumWire[]>(initialAlbums ?? []);
  const [hasAlbumSnapshot, setHasAlbumSnapshot] = useState(initialAlbums !== undefined);
  const [loadingAlbums, setLoadingAlbums] = useState(!initialAlbums);
  const [albumError, setAlbumError] = useState<string | null>(null);
  const [albumRevision, setAlbumRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('source');
  const [albumVisibleCount, setAlbumVisibleCount] = useState(120);
  useEffect(() => setAlbumVisibleCount(120), [search, sort]);
  const body = useRef<HTMLDivElement>(null);
  const listPosition = useRef(0);
  const [mediaState, setMediaState] = useState<MediaState>({
    status: 'idle',
    album: null,
    items: [],
    error: null,
  });

  useEffect(() => {
    if (!activity.enabled) {
      setLoadingAlbums(false);
      return;
    }
    if (initialAlbums && albumRevision === 0 && activity.revision === 0) return undefined;
    const controller = new AbortController();
    setLoadingAlbums(true);
    readWithRetry(
      () => client.account.listGroupAlbums.query({ groupCode, ...binding }),
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setAlbums(page);
        setHasAlbumSnapshot(true);
        setAlbumError(null);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setAlbumError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingAlbums(false);
      });
    return () => {
      controller.abort();
    };
  }, [groupCode, binding, initialAlbums, albumRevision, activity.enabled, activity.revision]);

  const activeTitle = mediaState.album?.title || '';
  const bodyTitle = mediaState.album ? activeTitle : '群相册';

  async function openAlbum(album: GroupAlbumWire): Promise<void> {
    if (!activity.enabled) return;
    mediaController.current?.abort();
    const controller = new AbortController();
    mediaController.current = controller;
    const revision = ++run.current;
    if (!mediaState.album) listPosition.current = body.current?.scrollTop ?? 0;
    setMediaState((previous) => ({
      status: 'loading',
      album,
      items: previous.album?.id === album.id ? previous.items : [],
      error: null,
    }));
    try {
      const access = await client.account.getGroupAlbumAccessState.query();
      if (!alive.current || revision !== run.current) return;
      if (!access.qqOnline) {
        throw new Error('需要先登录该账号的 QQ 客户端。');
      }
      const items = await readWithRetry(
        () =>
          client.account.listGroupAlbumMedia.query({
            groupCode,
            albumId: album.id,
            ...binding,
          }),
        controller.signal,
      );
      if (!alive.current || revision !== run.current) return;
      setMediaState({ status: 'ready', album, items, error: null });
    } catch (e) {
      if (!alive.current || revision !== run.current) return;
      setMediaState((previous) => ({
        status: 'ready',
        album,
        items: previous.album?.id === album.id ? previous.items : [],
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }

  const openRef = useRef(openAlbum);
  openRef.current = openAlbum;
  const currentAlbum = useRef(mediaState.album);
  currentAlbum.current = mediaState.album;
  useEffect(() => {
    if (activity.enabled && currentAlbum.current) void openRef.current(currentAlbum.current);
    if (!activity.enabled)
      setMediaState((previous) =>
        previous.status === 'loading' ? { ...previous, status: 'ready' } : previous,
      );
    return () => {
      run.current++;
      mediaController.current?.abort();
    };
  }, [activity.enabled, activity.revision]);
  const handledSearch = useRef('');
  useEffect(() => {
    if (
      !activity.enabled ||
      !hasAlbumSnapshot ||
      !initialAlbumId ||
      loadingAlbums ||
      albumError ||
      handledSearch.current === initialAlbumId
    )
      return;
    const album = albums.find((item) => item.id === initialAlbumId);
    if (album) {
      handledSearch.current = initialAlbumId;
      void openRef.current(album);
    } else setAlbumError('指定相册不存在或当前账号不可访问。');
  }, [initialAlbumId, albums, loadingAlbums, albumError, activity.enabled, hasAlbumSnapshot]);

  return (
    <OverlayLayer
      presentation="sidecar"
      title="群相册"
      className="modal-scrim group-album-scrim"
      onClose={onClose}
    >
      <section
        className="group-album-dialog group-album-browser"
        role="region"
        aria-label={`${groupName}的群相册`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <strong>{bodyTitle}</strong>
            <span>{groupName}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            title="关闭"
            aria-label="关闭群相册"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <div className="group-album-body" ref={body}>
          {mediaState.album ? (
            <AlbumMediaView
              key={mediaState.album.id}
              state={mediaState}
              groupCode={groupCode}
              onChanged={() => {
                setAlbumRevision((value) => value + 1);
                if (mediaState.album) void openAlbum(mediaState.album);
              }}
              onBack={() => {
                const revision = ++run.current;
                mediaController.current?.abort();
                const albumId = mediaState.album?.id;
                setMediaState({ status: 'idle', album: null, items: [], error: null });
                requestAnimationFrame(() => {
                  if (alive.current && revision === run.current && body.current) {
                    body.current.scrollTop = listPosition.current;
                    [...body.current.querySelectorAll<HTMLButtonElement>('[data-album-id]')]
                      .find((button) => button.dataset.albumId === albumId)
                      ?.focus({ preventScroll: true });
                  }
                });
              }}
            />
          ) : (
            <AlbumListView
              albums={albums}
              loading={loadingAlbums}
              error={albumError}
              disabled={!activity.enabled || mediaState.status === 'loading'}
              paused={!activity.enabled}
              search={search}
              onSearch={setSearch}
              sort={sort}
              onSort={setSort}
              visibleCount={albumVisibleCount}
              onMore={() => setAlbumVisibleCount((count) => count + 120)}
              onRefresh={() => {
                handledSearch.current = '';
                setAlbumRevision((value) => value + 1);
              }}
              onOpenAlbum={(album) => {
                handledSearch.current = initialAlbumId ?? '';
                void openAlbum(album);
              }}
            />
          )}
        </div>
      </section>
    </OverlayLayer>
  );
}

function AlbumListView({
  albums,
  loading,
  error,
  onOpenAlbum,
  disabled,
  paused,
  search,
  onSearch,
  sort,
  onSort,
  onRefresh,
  visibleCount,
  onMore,
}: {
  albums: GroupAlbumWire[];
  loading: boolean;
  error: string | null;
  onOpenAlbum: (album: GroupAlbumWire) => void;
  disabled?: boolean;
  paused?: boolean;
  search: string;
  onSearch: (value: string) => void;
  sort: string;
  onSort: (value: string) => void;
  onRefresh: () => void;
  visibleCount: number;
  onMore: () => void;
}): ReactElement {
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const result = albums.filter((album) =>
      `${album.title} ${album.desc} ${album.createNickname}`.toLocaleLowerCase().includes(query),
    );
    if (sort === 'name')
      result.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true }));
    else if (sort === 'count') result.sort((a, b) => b.photoCount - a.photoCount);
    return result;
  }, [albums, search, sort]);
  return (
    <>
      <div className="group-album-browse-tools">
        <label className="group-album-search">
          <Search size={15} />
          <input
            aria-label="搜索群相册"
            placeholder="搜索相册"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
        <select aria-label="相册排序" value={sort} onChange={(event) => onSort(event.target.value)}>
          <option value="source">原有顺序</option>
          <option value="name">名称</option>
          <option value="count">媒体数量</option>
        </select>
      </div>
      {!paused || albums.length ? (
        <p className="group-album-count" role="status">
          {search.trim()
            ? `${filtered.length} / ${albums.length} 本相册`
            : `${albums.length} 本相册`}
          {paused ? ' · 读取已暂停' : ''}
        </p>
      ) : null}
      {error && (
        <p className="group-album-read-error" role="alert">
          {error}
          <button
            type="button"
            className="group-album-tool"
            title="重试读取相册列表"
            aria-label="重试读取相册列表"
            disabled={loading || paused}
            onClick={onRefresh}
          >
            <RefreshCw size={16} />
          </button>
        </p>
      )}
      {loading && !paused && !albums.length ? (
        <div className="group-album-state">
          <Loader2 size={18} className="weq-spin" />
          正在查询群相册
        </div>
      ) : !filtered.length ? (
        <div className="group-album-state">
          {paused
            ? '读取已暂停'
            : search.trim()
              ? '没有匹配的相册'
              : error
                ? '相册暂时无法读取'
                : '暂无群相册'}
        </div>
      ) : (
        <div className="group-album-grid">
          {filtered.slice(0, visibleCount).map((album) => (
            <button
              key={album.id}
              className="group-album-card"
              type="button"
              disabled={disabled}
              onClick={() => onOpenAlbum(album)}
              title={album.title || '未命名相册'}
              data-album-id={album.id}
            >
              <AlbumCover album={album} />
              <span>
                <strong>{album.title || '未命名相册'}</strong>
                <small>{album.photoCount ?? 0} 项</small>
                {album.desc && <small>{album.desc}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
      {filtered.length > visibleCount && (
        <button type="button" className="group-album-more" onClick={onMore}>
          显示更多（{visibleCount} / {filtered.length}）
        </button>
      )}
    </>
  );
}

function AlbumCover({ album }: { album: GroupAlbumWire }): ReactElement {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [album.coverUrl]);
  if (!album.coverUrl || broken) {
    return (
      <span className="group-album-cover is-empty">
        <Image size={22} />
      </span>
    );
  }
  return (
    <span className="group-album-cover">
      <img
        src={album.coverUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    </span>
  );
}

function AlbumMediaView({
  state,
  onBack,
  groupCode,
  onChanged,
}: {
  state: MediaState;
  onBack: () => void;
  groupCode: string;
  onChanged: () => void;
}): ReactElement {
  const items = state.items;
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<'all' | 'image' | 'video'>('all');
  const [visibleCount, setVisibleCount] = useState(120);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [preview, setPreview] = useState<{ key: string; items: AlbumMediaWire[] } | null>(null);
  useEffect(() => setVisibleCount(120), [search, kind]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return items.filter(
      (item) =>
        (kind === 'all' || kind === item.kind) &&
        `${item.fileName} ${item.uploader}`.toLocaleLowerCase().includes(query),
    );
  }, [items, search, kind]);
  const previews = useMemo<QzonePreviewMedia[]>(
    () =>
      (preview?.items ?? []).map((item) => {
        const full = item.originalUrl || item.previewUrl;
        return {
          key: mediaKey(item),
          kind: item.kind === 'video' && item.originalUrl ? 'video' : 'image',
          src: full ? albumMediaUrl(full) : '',
          poster: item.previewUrl ? albumMediaUrl(item.previewUrl) : undefined,
          title: item.fileName || (item.kind === 'video' ? '群相册视频' : '群相册图片'),
          ...(item.kind === 'image' &&
          item.previewUrl &&
          item.originalUrl &&
          item.previewUrl !== item.originalUrl
            ? {
                src: albumMediaUrl(item.previewUrl),
                load: async () => ({
                  src: albumMediaUrl(item.originalUrl),
                  kind: 'image' as const,
                }),
              }
            : {}),
        };
      }),
    [preview],
  );
  const countText = useMemo(() => {
    const videos = items.filter((item) => item.kind === 'video').length;
    const photos = items.length - videos;
    if (!videos) return `${photos} 张`;
    if (!photos) return `${videos} 个视频`;
    return `${photos} 张 · ${videos} 个视频`;
  }, [items]);
  return (
    <div className="group-album-media-view">
      <div className="group-album-toolbar">
        <button
          type="button"
          className="group-album-back"
          title="返回相册列表"
          aria-label="返回相册列表"
          onClick={onBack}
        >
          <ArrowLeft size={15} />
          相册
        </button>
        <span>{state.status === 'loading' && !items.length ? '正在读取' : countText}</span>
        <div className="group-album-toolbar-actions">
          <button
            type="button"
            className="group-album-tool"
            title="上传图片"
            aria-label="上传图片"
            aria-expanded={uploadOpen}
            disabled={state.status === 'loading'}
            onClick={() => setUploadOpen((open) => !open)}
          >
            <ImagePlus size={17} />
          </button>
          {state.error && (
            <button
              type="button"
              className="group-album-tool"
              title="重试读取相册媒体"
              aria-label="重试读取相册媒体"
              disabled={state.status === 'loading'}
              onClick={onChanged}
            >
              <RefreshCw
                size={16}
                className={state.status === 'loading' ? 'weq-spin' : undefined}
              />
            </button>
          )}
        </div>
      </div>
      {state.album && uploadOpen && (
        <div className="group-album-upload">
          <GroupAlbumUpload
            key={state.album.id}
            groupId={Number(groupCode)}
            albumId={state.album.id}
            albumName={state.album.title}
            onChanged={onChanged}
          />
        </div>
      )}
      <div className="group-album-browse-tools">
        <label className="group-album-search">
          <Search size={15} />
          <input
            aria-label="搜索相册媒体"
            placeholder="搜索文件名或上传者"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="group-album-kind" role="group" aria-label="媒体类型">
          {(['all', 'image', 'video'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-label={
                value === 'all' ? '全部媒体' : value === 'image' ? '只看图片' : '只看视频'
              }
              title={value === 'all' ? '全部媒体' : value === 'image' ? '只看图片' : '只看视频'}
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
            >
              {value === 'all' ? (
                <Images size={16} />
              ) : value === 'image' ? (
                <Image size={16} />
              ) : (
                <Film size={16} />
              )}
            </button>
          ))}
        </div>
      </div>
      {state.error && (
        <p className="group-album-read-error" role="alert">
          {state.error}
        </p>
      )}
      {state.status === 'loading' && !items.length ? (
        <div className="group-album-state">
          <Loader2 size={18} className="weq-spin" />
          <span>正在加载媒体</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="group-album-state">
          {items.length
            ? '没有匹配的媒体'
            : state.error
              ? '媒体暂时无法读取，可重试读取'
              : '这个相册暂无图片或视频'}
        </div>
      ) : (
        <div className="group-album-media-grid">
          {filtered.slice(0, visibleCount).map((item) => (
            <MediaThumbnail
              key={mediaKey(item)}
              item={item}
              onOpen={() => setPreview({ key: mediaKey(item), items: filtered })}
            />
          ))}
        </div>
      )}
      {!!filtered.length && (
        <p className="group-album-count" role="status">
          显示 {Math.min(visibleCount, filtered.length)} / {filtered.length} 项
          {filtered.length !== items.length ? `，相册已读取 ${items.length} 项` : ''}
        </p>
      )}
      {filtered.length > visibleCount && (
        <button
          type="button"
          className="group-album-more"
          onClick={() => setVisibleCount((count) => count + 120)}
        >
          显示更多
        </button>
      )}
      {preview && (
        <QzoneMediaPreview
          key={preview.key}
          label="群相册媒体预览"
          items={previews}
          initialIndex={previews.findIndex((item) => item.key === preview.key)}
          onClose={() => setPreview(null)}
          renderActions={(current) => {
            const item = preview.items.find((item) => mediaKey(item) === current.key);
            if (!item) return null;
            const isVideo = item.kind === 'video';
            const mediaId = isVideo ? item.video?.id : item.image?.lloc;
            const onlyCover = isVideo && !item.originalUrl;
            return (
              <div className="group-album-preview-details">
                <div className="group-album-preview-meta">
                  <strong title={item.fileName}>{item.fileName || '未命名媒体'}</strong>
                  <span>
                    {onlyCover ? '视频本体不可用，仅显示封面' : isVideo ? '视频' : '图片'} · 上传者{' '}
                    {item.uploader || '未知'}
                  </span>
                </div>
                <MediaSourceSave
                  key={`save:${current.key}`}
                  source={{
                    kind: 'url',
                    url: albumMediaUrl(item.originalUrl || item.previewUrl),
                    name: onlyCover ? `${item.fileName || '视频'}-封面` : item.fileName,
                  }}
                  label={onlyCover ? '保存视频封面' : isVideo ? '保存视频' : '保存图片'}
                  className="group-album-preview-save"
                />
                {state.album && mediaId && /^\d+$/.test(item.batchId) && (
                  <GroupAlbumMediaActions
                    key={`actions:${current.key}`}
                    groupId={Number(groupCode)}
                    albumId={state.album.id}
                    mediaId={mediaId}
                    deleteMediaId={isVideo ? item.video?.cover?.lloc || '' : undefined}
                    batchId={item.batchId}
                    uploaderUin={item.uploader}
                    uploadTime={Number(item.uploadTime)}
                    onChanged={() => {
                      setPreview(null);
                      onChanged();
                    }}
                  />
                )}
              </div>
            );
          }}
        />
      )}
    </div>
  );
}

function mediaKey(item: AlbumMediaWire): string {
  return `${item.kind}:${(item.kind === 'video' ? item.video?.id : item.image?.lloc) || item.originalUrl || item.previewUrl}`;
}

function MediaThumbnail({
  item,
  onOpen,
}: {
  item: AlbumMediaWire;
  onOpen: () => void;
}): ReactElement {
  const [broken, setBroken] = useState(false);
  const src = item.previewUrl || (item.kind === 'image' ? item.originalUrl : '');
  useEffect(() => setBroken(false), [src]);
  return (
    <button
      type="button"
      className={`group-album-media-card${item.kind === 'video' ? ' is-video' : ''}`}
      onClick={onOpen}
      aria-label={`预览 ${item.fileName || (item.kind === 'video' ? '视频' : '图片')}`}
      title={item.fileName || '未命名媒体'}
    >
      {src && !broken ? (
        <img
          src={albumMediaUrl(src)}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="group-album-thumbnail-fallback">
          <Image size={24} />
          <small>{broken ? '预览加载失败' : '暂无封面'}</small>
        </span>
      )}
      {item.kind === 'video' && (
        <span className="group-album-media-play" aria-hidden>
          <Play size={18} />
        </span>
      )}
      <span className="group-album-media-name">{item.fileName || '未命名媒体'}</span>
    </button>
  );
}

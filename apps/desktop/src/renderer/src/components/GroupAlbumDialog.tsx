// @ts-nocheck
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Image, Loader2, Play, X } from 'lucide-react';
import { client } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { albumMediaUrl } from '../lib/resourceUrl';
import { openLightbox } from './ImageLightbox';
import { openVideoLightbox } from './VideoLightbox';
import { OverlayLayer } from './OverlayLayer';
import { GroupAlbumMediaActions, GroupAlbumUpload } from './qq-actions/MediaActions';

export interface GroupAlbumWire {
  id: string;
  title: string;
  photoCount: number;
  coverUrl: string;
  desc: string;
  createUin: number;
  createNickname: string;
  createTime: string;
  updateTime: string;
}

interface AlbumMediaWire {
  type: number;
  kind: 'image' | 'video';
  image: {
    name: string;
    sloc: string;
    lloc: string;
    isGif: boolean;
    hasRaw: boolean;
  } | null;
  video?: { id: string; cover: { lloc: string } | null } | null;
  uploader: string;
  batchId: string;
  uploadTime: string;
  previewUrl: string;
  originalUrl: string;
  fileName: string;
}

type MediaState =
  | { status: 'idle'; album: GroupAlbumWire | null; items: AlbumMediaWire[]; error: string | null }
  | { status: 'loading'; album: GroupAlbumWire; items: AlbumMediaWire[]; error: string | null }
  | { status: 'ready'; album: GroupAlbumWire; items: AlbumMediaWire[]; error: string | null };

export function GroupAlbumDialog({
  groupCode,
  groupName,
  initialAlbums,
  initialAlbumId,
  onClose,
}: {
  groupCode: string;
  groupName: string;
  initialAlbums?: GroupAlbumWire[];
  initialAlbumId?: string;
  onClose: () => void;
}): ReactElement {
  const dialog = useAppDialog();
  const alive = useRef(true);
  const run = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      run.current++;
    };
  }, []);
  const [albums, setAlbums] = useState<GroupAlbumWire[]>(initialAlbums ?? []);
  const [loadingAlbums, setLoadingAlbums] = useState(!initialAlbums);
  const [albumError, setAlbumError] = useState<string | null>(null);
  const [mediaState, setMediaState] = useState<MediaState>({
    status: 'idle',
    album: null,
    items: [],
    error: null,
  });

  useEffect(() => {
    if (initialAlbums) return undefined;
    let cancelled = false;
    setLoadingAlbums(true);
    client.account.listGroupAlbums
      .query({ groupCode })
      .then((page) => {
        if (cancelled) return;
        setAlbums(page as GroupAlbumWire[]);
        setAlbumError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setAlbumError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingAlbums(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupCode, initialAlbums]);

  const activeTitle = mediaState.album?.title || '';
  const bodyTitle = mediaState.album ? activeTitle : '群相册';

  async function openAlbum(album: GroupAlbumWire): Promise<void> {
    const revision = ++run.current;
    try {
      const access = await client.account.getGroupAlbumAccessState.query();
      if (!alive.current || revision !== run.current) return;
      if (!access.qqOnline) {
        dialog.error('无法查看群相册', '需要先登录该账号的 QQ 客户端。');
        return;
      }
      setMediaState({ status: 'loading', album, items: [], error: null });
      const items = (await client.account.listGroupAlbumMedia.query({
        groupCode,
        albumId: album.id,
      })) as AlbumMediaWire[];
      if (!alive.current || revision !== run.current) return;
      setMediaState({ status: 'ready', album, items, error: null });
    } catch (e) {
      if (!alive.current || revision !== run.current) return;
      setMediaState({
        status: 'ready',
        album,
        items: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const openRef = useRef(openAlbum);
  openRef.current = openAlbum;
  const handledSearch = useRef('');
  useEffect(() => {
    if (!initialAlbumId || loadingAlbums || albumError || handledSearch.current === initialAlbumId)
      return;
    handledSearch.current = initialAlbumId;
    const album = albums.find((item) => item.id === initialAlbumId);
    if (album) void openRef.current(album);
    else setAlbumError('搜索命中的相册不存在或当前账号不可访问。');
  }, [initialAlbumId, albums, loadingAlbums, albumError]);

  return (
    <OverlayLayer
      presentation="sidecar"
      title="群相册"
      className="modal-scrim group-album-scrim"
      onClose={onClose}
    >
      <section
        className="group-album-dialog"
        role="region"
        aria-label={`${groupName}的群相册`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <strong>{bodyTitle}</strong>
            <span>{groupName}</span>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="group-album-body">
          {mediaState.album ? (
            <AlbumMediaView
              state={mediaState}
              groupCode={groupCode}
              onChanged={() => {
                if (mediaState.album) void openAlbum(mediaState.album);
              }}
              onBack={() => setMediaState({ status: 'idle', album: null, items: [], error: null })}
            />
          ) : (
            <AlbumListView
              albums={albums}
              loading={loadingAlbums}
              error={albumError}
              disabled={mediaState.status === 'loading'}
              onOpenAlbum={(album) => void openAlbum(album)}
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
}: {
  albums: GroupAlbumWire[];
  loading: boolean;
  error: string | null;
  onOpenAlbum: (album: GroupAlbumWire) => void;
  disabled?: boolean;
}): ReactElement {
  if (loading) {
    return (
      <div className="group-album-state">
        <Loader2 size={18} className="weq-spin" />
        <span>正在查询群相册列表喵~</span>
      </div>
    );
  }
  if (error) {
    return <div className="group-album-state is-error">{error}</div>;
  }
  if (albums.length === 0) {
    return <div className="group-album-state">暂无群相册</div>;
  }
  return (
    <div className="group-album-grid">
      {albums.map((album) => (
        <button
          key={album.id}
          className="group-album-card"
          type="button"
          disabled={disabled}
          onClick={() => onOpenAlbum(album)}
        >
          <AlbumCover album={album} />
          <span>
            <strong>{album.title || '未命名相册'}</strong>
            <small>{album.photoCount ?? 0} 张</small>
          </span>
        </button>
      ))}
    </div>
  );
}

function AlbumCover({ album }: { album: GroupAlbumWire }): ReactElement {
  const [broken, setBroken] = useState(false);
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
        <button type="button" className="group-album-back" onClick={onBack}>
          返回相册
        </button>
        <span>{countText}</span>
      </div>
      {state.album && (
        <GroupAlbumUpload
          key={state.album.id}
          groupId={Number(groupCode)}
          albumId={state.album.id}
          albumName={state.album.title}
          onChanged={onChanged}
        />
      )}
      {state.status === 'loading' ? (
        <div className="group-album-state">
          <Loader2 size={18} className="weq-spin" />
          <span>正在加载媒体</span>
        </div>
      ) : state.error ? (
        <div className="group-album-state is-error">{state.error}</div>
      ) : items.length === 0 ? (
        <div className="group-album-state">这个相册没有可预览的图片</div>
      ) : (
        <div className="group-album-media-grid">
          {items.map((item) => {
            const src = item.previewUrl || item.originalUrl;
            const full = item.originalUrl || item.previewUrl;
            const proxiedFull = full ? albumMediaUrl(full) : '';
            const isVideo = item.kind === 'video';
            const mediaId = isVideo ? item.video?.id : item.image?.lloc;
            return (
              <div
                className="weq-qq-album-item"
                key={mediaId || item.originalUrl || `${item.batchId}:${item.fileName}`}
              >
                <button
                  type="button"
                  className={`group-album-media-card${isVideo ? ' is-video' : ''}`}
                  onClick={() => {
                    if (!proxiedFull) return;
                    // 视频走 <video> 灯箱,图片走图片灯箱。
                    if (isVideo) {
                      openVideoLightbox(
                        proxiedFull,
                        src ? albumMediaUrl(src) : undefined,
                        item.fileName,
                      );
                    } else openLightbox(proxiedFull, item.fileName || '群相册图片');
                  }}
                >
                  <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  {isVideo ? (
                    <span className="group-album-media-play" aria-hidden>
                      <Play size={18} />
                    </span>
                  ) : null}
                </button>
                {state.album && mediaId && /^\d+$/.test(item.batchId) && (
                  <GroupAlbumMediaActions
                    groupId={Number(groupCode)}
                    albumId={state.album.id}
                    mediaId={mediaId}
                    deleteMediaId={isVideo ? item.video?.cover?.lloc || '' : undefined}
                    batchId={item.batchId}
                    uploaderUin={item.uploader}
                    uploadTime={Number(item.uploadTime)}
                    onChanged={onChanged}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

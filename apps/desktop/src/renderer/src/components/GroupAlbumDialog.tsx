// @ts-nocheck
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Image, Loader2, X } from 'lucide-react';
import { client } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { albumMediaUrl } from '../lib/resourceUrl';
import { openLightbox } from './ImageLightbox';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';

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
  image: {
    name: string;
    sloc: string;
    lloc: string;
    isGif: boolean;
    hasRaw: boolean;
  } | null;
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
  onClose,
}: {
  groupCode: string;
  groupName: string;
  initialAlbums?: GroupAlbumWire[];
  onClose: () => void;
}): ReactElement {
  useEscapeToClose(onClose);
  const dialog = useAppDialog();
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
    const access = await client.account.getGroupAlbumAccessState.query();
    if (!access.qqOnline) {
      dialog.error('无法查看群相册', '需要先登录该账号的 QQ 客户端。');
      return;
    }
    setMediaState({ status: 'loading', album, items: [], error: null });
    try {
      const items = (await client.account.listGroupAlbumMedia.query({
        groupCode,
        albumId: album.id,
      })) as AlbumMediaWire[];
      setMediaState({ status: 'ready', album, items, error: null });
    } catch (e) {
      setMediaState({
        status: 'ready',
        album,
        items: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div className="modal-scrim group-album-scrim" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <section className="group-album-dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
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
            <AlbumMediaView state={mediaState} onBack={() => setMediaState({ status: 'idle', album: null, items: [], error: null })} />
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
    </div>
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
        <span>正在加载群相册</span>
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
        <button key={album.id} className="group-album-card" type="button" disabled={disabled} onClick={() => onOpenAlbum(album)}>
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
      <img src={album.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    </span>
  );
}

function AlbumMediaView({
  state,
  onBack,
}: {
  state: MediaState;
  onBack: () => void;
}): ReactElement {
  const items = state.items;
  const countText = useMemo(() => `${items.length} 张`, [items.length]);
  return (
    <div className="group-album-media-view">
      <div className="group-album-toolbar">
        <button type="button" className="group-album-back" onClick={onBack}>
          返回相册
        </button>
        <span>{countText}</span>
      </div>
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
          {items.map((item, index) => {
            const src = item.previewUrl || item.originalUrl;
            const full = item.originalUrl || item.previewUrl;
            const proxiedFull = full ? albumMediaUrl(full) : '';
            return (
              <button
                key={`${item.batchId}:${item.fileName}:${index}`}
                type="button"
                className="group-album-media-card"
                onClick={() => proxiedFull && openLightbox(proxiedFull, item.fileName || '群相册图片')}
              >
                <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

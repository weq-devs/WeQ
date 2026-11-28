import { usePreferenceState } from '../lib/clientPreferences';
import { ToolbarLabel } from './CompactToolbar';
import { filterByName } from '../lib/nameSearch';
import { observeCompactToolbar } from './CompactToolbar.shared';
import { NumericText } from './NumericText';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type HTMLAttributes,
} from 'react';
import { useContentMultiSelect } from '../state/contentSelection.shared';
import { useMultiSelection } from '../hooks/useMultiSelection';
import { ContentReferenceToolbar } from './ContentReferenceToolbar';
import { contentReferenceKey, type ContentReference } from '../../../shared/content_selection';
import { groupAlbumMediaKey } from '../../../shared/album_media_identity';
import { mobileBack, useMobileBack } from '../hooks/useMobileNavigation';
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
import { ShimmerImage } from './ShimmerImage';
import { MediaPreview, type PreviewMedia } from './MediaPreview';
import { ContactEmptyState } from './contactProfile/ContactRow';
import { ProfileDetailSurface } from './ProfileDetailSurface';
import { GroupAlbumMediaActions, GroupAlbumUpload } from './qq-actions/MediaActions';
import { GroupAlbumManagement } from './qq-actions/GroupAlbumManagement';
import { GroupAlbumVideoUpload } from './qq-actions/GroupAlbumVideoUpload';
import { withQQAccountScope } from './qq-actions/shared.shared';
import { useQQReadActivity } from '../hooks/useQQAutoRefresh';
import { readWithRetry } from '../lib/autoRead';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { resourceForRenderDocument, useRenderDocument } from '../lib/renderDocument';
import { usePageDataCache, usePageState } from './PageSnapshots.shared';
import { PageScrollSnapshot } from './PageScrollSnapshot';
import { pageValue } from '../lib/pageSnapshots';
import { isRecentPageRead, PageDataCache } from '../lib/pageDataCache';
import { GroupResourceNavigation } from './GroupResourceNavigation';
import '../styles/group-media.css';
import '../styles/group-album-browser.css';

type AccountOutput = inferRouterOutputs<AppRouter>['account'];
export type GroupAlbumWire = AccountOutput['listGroupAlbums'][number];
type AlbumMediaWire = AccountOutput['listGroupAlbumMedia'][number];
type AlbumListSnapshot = AccountOutput['listGroupAlbumBrowse'] & { checkedAt: number };
type AlbumMediaSnapshot = { items: AlbumMediaWire[]; checkedAt: number };

type MediaState =
  | { status: 'idle'; album: GroupAlbumWire | null; items: AlbumMediaWire[]; error: string | null }
  | { status: 'loading'; album: GroupAlbumWire; items: AlbumMediaWire[]; error: string | null }
  | { status: 'ready'; album: GroupAlbumWire; items: AlbumMediaWire[]; error: string | null };

export interface GroupAlbumDialogProps {
  embedded?: boolean;
  standalone?: boolean;
  groupCode: string;
  groupName: string;
  initialAlbums?: GroupAlbumWire[];
  initialAlbumId?: string;
  binding?: QQWriteBinding;
  onClose: () => void;
}
const ScopedGroupAlbumDialog = withQQAccountScope(GroupAlbumDialogBody, (props) => ({
  kind: 'group-resource',
  request: {
    kind: 'albums',
    groupCode: props.groupCode,
    groupName: props.groupName,
    initialAlbumId: props.initialAlbumId,
  },
}));
export function GroupAlbumDialog(props: GroupAlbumDialogProps): ReactElement {
  return <ScopedGroupAlbumDialog key={props.groupCode} {...props} />;
}
function GroupAlbumDialogBody({
  embedded,
  standalone,
  groupCode,
  groupName,
  initialAlbums,
  initialAlbumId,
  binding,
  onClose,
}: GroupAlbumDialogProps): ReactElement {
  const document = useRenderDocument();
  const view = document.defaultView ?? window;
  const detached = document !== globalThis.document;
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
  const [fallbackCache] = useState(() => new PageDataCache());
  const pageCache = usePageDataCache(fallbackCache);
  const listKey = JSON.stringify(['group-albums', binding, groupCode]);
  const [albumSnapshot, setAlbumSnapshot] = useState(() =>
    pageCache.read<AlbumListSnapshot>(listKey),
  );
  const albums = albumSnapshot?.albums ?? initialAlbums ?? [];
  const hasAlbumSnapshot = albumSnapshot !== undefined || initialAlbums !== undefined;
  const [loadingAlbums, setLoadingAlbums] = useState(activity.enabled && !hasAlbumSnapshot);
  const [albumError, setAlbumError] = useState<string | null>(null);
  const albumIncomplete = albumSnapshot?.complete === false;
  const [albumRevision, setAlbumRevision] = useState(0);
  const lastAlbumRead = useRef({
    revision: 0,
    activityRevision: activity.revision,
    checkedAt: albumSnapshot?.checkedAt ?? 0,
  });
  const [search, setSearch] = usePageState(
    `group-albums:${groupCode}:search`,
    '',
    pageValue.string,
  );
  const [lastAlbumId, setLastAlbumId] = usePageState<string | null>(
    `group-albums:${groupCode}:selected`,
    null,
    pageValue.optionalString,
    false,
    !initialAlbumId,
  );
  const [sort, setSort] = usePreferenceState('groupAlbumSort');
  const [albumVisibleCount, setAlbumVisibleCount] = usePageState(
    `group-albums:${groupCode}:visible`,
    120,
    pageValue.number,
  );
  const body = useRef<HTMLDivElement>(null);
  const listPosition = useRef(0);
  const mediaKey = (albumId: string) =>
    JSON.stringify(['group-album-media', binding, groupCode, albumId]);
  const [mediaState, setMediaState] = useState<MediaState>({
    status: 'idle',
    album: null,
    items: [],
    error: null,
  });
  const backToAlbums = () => {
    const revision = ++run.current;
    mediaController.current?.abort();
    const albumId = mediaState.album?.id;
    setLastAlbumId(null);
    setMediaState({ status: 'idle', album: null, items: [], error: null });
    view.requestAnimationFrame(() => {
      if (alive.current && revision === run.current && body.current) {
        body.current.scrollTop = listPosition.current;
        [...body.current.querySelectorAll<HTMLButtonElement>('[data-album-id]')]
          .find((button) => button.dataset.albumId === albumId)
          ?.focus({ preventScroll: true });
      }
    });
  };
  useMobileBack(
    Boolean(mediaState.album) && !standalone && !detached,
    backToAlbums,
    30,
    () => body.current,
  );

  useEffect(() => {
    if (!activity.enabled) {
      setLoadingAlbums(false);
      return;
    }
    const forced =
      lastAlbumRead.current.revision !== albumRevision ||
      lastAlbumRead.current.activityRevision !== activity.revision;
    if (
      !forced &&
      (isRecentPageRead(lastAlbumRead.current.checkedAt) ||
        (initialAlbums && albumRevision === 0 && activity.revision === 0))
    )
      return;
    lastAlbumRead.current = {
      revision: albumRevision,
      activityRevision: activity.revision,
      checkedAt: 0,
    };
    const controller = new AbortController();
    setLoadingAlbums(true);
    readWithRetry(
      () =>
        client.account.listGroupAlbumBrowse.query(
          { groupCode, ...binding },
          { signal: controller.signal },
        ),
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        const checkedAt = page.complete ? Date.now() : 0;
        lastAlbumRead.current.checkedAt = checkedAt;
        // 不完整的回包可以补入已确认条目，缺失项等完整清单再移除。
        const previous = page.complete ? undefined : pageCache.read<AlbumListSnapshot>(listKey);
        const ids = new Set(page.albums.map((album) => album.id));
        const snapshot = {
          ...page,
          albums: previous
            ? [...page.albums, ...previous.albums.filter((album) => !ids.has(album.id))]
            : page.albums,
          checkedAt,
        };
        pageCache.write(listKey, snapshot);
        setAlbumSnapshot(snapshot);
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
  }, [
    groupCode,
    binding,
    initialAlbums,
    albumRevision,
    activity.enabled,
    activity.revision,
    pageCache,
    listKey,
  ]);

  const activeTitle = mediaState.album?.title || '';
  const bodyTitle = mediaState.album ? activeTitle : '群相册';

  async function openAlbum(album: GroupAlbumWire, force = false): Promise<void> {
    const cacheKey = mediaKey(album.id);
    const cached = pageCache.read<AlbumMediaSnapshot>(cacheKey);
    if (!activity.enabled && !cached) return;
    mediaController.current?.abort();
    const controller = new AbortController();
    mediaController.current = controller;
    const revision = ++run.current;
    if (!mediaState.album) listPosition.current = body.current?.scrollTop ?? 0;
    setLastAlbumId(album.id);
    setMediaState((previous) => ({
      status: cached !== undefined ? 'ready' : 'loading',
      album,
      items: previous.album?.id === album.id ? previous.items : (cached?.items ?? []),
      error: null,
    }));
    if (!activity.enabled || (!force && cached && isRecentPageRead(cached.checkedAt))) return;
    if (force && cached) pageCache.write(cacheKey, { ...cached, checkedAt: 0 });
    try {
      const access = await client.account.getGroupAlbumAccessState.query(undefined, {
        signal: controller.signal,
      });
      if (!alive.current || revision !== run.current) return;
      if (!access.qqOnline) {
        throw new Error('需要先登录该账号的 QQ 客户端。');
      }
      const items = await readWithRetry(
        () =>
          client.account.listGroupAlbumMedia.query(
            { groupCode, albumId: album.id, ...binding },
            { signal: controller.signal },
          ),
        controller.signal,
      );
      if (!alive.current || revision !== run.current) return;
      pageCache.write(cacheKey, { items, checkedAt: Date.now() } satisfies AlbumMediaSnapshot);
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
  const mediaActivityRevision = useRef(activity.revision);
  useEffect(() => {
    if (activity.enabled) {
      const resumed = mediaActivityRevision.current !== activity.revision;
      mediaActivityRevision.current = activity.revision;
      if (currentAlbum.current) void openRef.current(currentAlbum.current, resumed);
    }
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
  const targetAlbumId = initialAlbumId ?? lastAlbumId;
  useLayoutEffect(() => {
    if (
      !hasAlbumSnapshot ||
      !targetAlbumId ||
      handledSearch.current === targetAlbumId ||
      mediaState.album
    )
      return;
    const album = albums.find((item) => item.id === targetAlbumId);
    if (album && activity.enabled) {
      handledSearch.current = targetAlbumId;
      void openRef.current(album);
    } else if (
      initialAlbumId &&
      !album &&
      (albumSnapshot?.complete ?? initialAlbums !== undefined) &&
      !loadingAlbums &&
      !albumError
    )
      setAlbumError('指定相册不存在或当前账号不可访问。');
  }, [
    initialAlbumId,
    initialAlbums,
    targetAlbumId,
    albums,
    albumSnapshot?.complete,
    loadingAlbums,
    albumError,
    activity.enabled,
    hasAlbumSnapshot,
    mediaState.album,
  ]);

  const management = (
    <GroupAlbumManagement
      key={`${groupCode}:${mediaState.album?.id ?? 'new'}`}
      groupCode={groupCode}
      album={mediaState.album}
      onChanged={() => {
        setAlbumRevision((value) => value + 1);
        if (mediaState.album) {
          pageCache.write(mediaKey(mediaState.album.id), { items: mediaState.items, checkedAt: 0 });
        }
        setLastAlbumId(null);
        setMediaState({ status: 'idle', album: null, items: [], error: null });
      }}
    />
  );
  return (
    <ProfileDetailSurface
      embedded={embedded}
      presentation="sidecar"
      title="群相册"
      className="modal-scrim group-album-scrim"
      onClose={onClose}
    >
      <section
        className={`group-album-dialog group-album-browser${standalone ? ' is-standalone' : ''}`}
        role="region"
        aria-label={`${groupName}的群相册`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <strong>{standalone ? '群相册' : bodyTitle}</strong>
            <span>{groupName}</span>
          </div>
          {standalone ? (
            <div className="weq-group-resource-header-actions">{management}</div>
          ) : null}
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

        <PageScrollSnapshot
          className="group-album-body"
          scrollRef={body}
          snapshotKey={JSON.stringify(['group-albums', groupCode, mediaState.album?.id])}
        >
          {standalone ? (
            <GroupResourceNavigation
              label="群相册目录"
              items={[
                { id: 'albums', name: '全部相册' },
                ...(mediaState.album
                  ? [{ id: mediaState.album.id, name: mediaState.album.title || '未命名相册' }]
                  : []),
              ]}
              onBack={backToAlbums}
              onSelect={(index) => {
                if (index === 0 && mediaState.album) backToAlbums();
              }}
            />
          ) : null}
          {!standalone ? management : null}
          {mediaState.album ? (
            <AlbumMediaView
              key={mediaState.album.id}
              state={mediaState}
              groupCode={groupCode}
              hideNavigation={standalone}
              onChanged={() => {
                setAlbumRevision((value) => value + 1);
                if (mediaState.album) void openAlbum(mediaState.album, true);
              }}
              onBack={() => {
                if (standalone || detached || !mobileBack()) backToAlbums();
              }}
            />
          ) : (
            <AlbumListView
              groupCode={groupCode}
              albums={albums}
              loading={loadingAlbums}
              hasSnapshot={hasAlbumSnapshot}
              error={albumError ?? (albumIncomplete ? '相册列表未读全，已显示取得的相册。' : null)}
              disabled={!activity.enabled || mediaState.status === 'loading'}
              paused={!activity.enabled}
              search={search}
              onSearch={(value) => {
                setSearch(value);
                setAlbumVisibleCount(120);
              }}
              sort={sort}
              onSort={(value) => {
                setSort(value);
                setAlbumVisibleCount(120);
              }}
              visibleCount={albumVisibleCount}
              onMore={() => setAlbumVisibleCount((count) => count + 120)}
              onRefresh={() => {
                handledSearch.current = '';
                setAlbumRevision((value) => value + 1);
              }}
              onOpenAlbum={(album) => {
                handledSearch.current = initialAlbumId ?? album.id;
                void openAlbum(album);
              }}
            />
          )}
        </PageScrollSnapshot>
      </section>
    </ProfileDetailSurface>
  );
}

function AlbumListView({
  groupCode,
  albums,
  loading,
  hasSnapshot,
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
  groupCode: string;
  albums: GroupAlbumWire[];
  loading: boolean;
  hasSnapshot: boolean;
  error: string | null;
  onOpenAlbum: (album: GroupAlbumWire) => void;
  disabled?: boolean;
  paused?: boolean;
  search: string;
  onSearch: (value: string) => void;
  sort: 'source' | 'name' | 'count';
  onSort: (value: 'source' | 'name' | 'count') => void;
  onRefresh: () => void;
  visibleCount: number;
  onMore: () => void;
}): ReactElement {
  const filtered = useMemo(() => {
    const result = [...albums];
    if (sort === 'name')
      result.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true }));
    else if (sort === 'count') result.sort((a, b) => b.photoCount - a.photoCount);
    return filterByName(
      result,
      search,
      (album) => [album.title, album.createNickname],
      (album, query) =>
        `${album.title} ${album.desc} ${album.createNickname}`.toLocaleLowerCase().includes(query),
    );
  }, [albums, search, sort]);
  const owner = { kind: 'group-albums' as const, container: groupCode };
  const references = useMemo(
    () =>
      new Map<string, ContentReference>(
        filtered.map((album) => {
          const item: ContentReference = {
            kind: 'group-album',
            groupCode,
            albumId: album.id,
            name: album.title,
          };
          return [contentReferenceKey(item), item];
        }),
      ),
    [filtered, groupCode],
  );
  const selection = useContentMultiSelect(owner, true, references);
  const multi = useMultiSelection({
    ids: [...references.keys()],
    selected: selection.selectedIds,
    onChange: selection.setSelectedIds,
    enabled: selection.selectionMode,
    onStart: () => selection.setSelectionMode(true),
    onExit: () => selection.setSelectionMode(false),
    anchorRef: selection.anchorRef,
  });
  return (
    <>
      <div className="group-album-browse-tools">
        <ContentReferenceToolbar
          owner={owner}
          selection={selection}
          loaded={[...references.keys()]}
        />
        <label className="group-album-search">
          <Search size={15} />
          <input
            aria-label="搜索群相册"
            placeholder="搜索相册"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
        <SegmentedControl
          label="相册排序"
          value={sort}
          onChange={onSort}
          options={[
            { value: 'source', label: '原有顺序' },
            { value: 'name', label: '名称' },
            { value: 'count', label: '媒体数量' },
          ]}
        />
      </div>
      {!paused || albums.length ? (
        <p className="group-album-count" role="status">
          {search.trim() ? (
            <NumericText>{`${filtered.length} / ${albums.length} 本相册`}</NumericText>
          ) : (
            <NumericText>{`${albums.length} 本相册`}</NumericText>
          )}
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
      {loading && !paused && !hasSnapshot ? (
        <div className="group-album-state">
          <Loader2 size={18} className="weq-spin" />
          正在查询群相册
        </div>
      ) : !filtered.length ? (
        <ContactEmptyState>
          {paused
            ? '读取已暂停，切回本章节会继续。'
            : search.trim()
              ? '没有匹配的相册。'
              : error
                ? '群相册暂时无法读取，可稍后重试。'
                : '还没有群相册。'}
        </ContactEmptyState>
      ) : (
        <div {...multi.rootProps} className="group-album-grid">
          {filtered.slice(0, visibleCount).map((album) => (
            <button
              key={album.id}
              {...multi.itemProps(
                contentReferenceKey({ kind: 'group-album', groupCode, albumId: album.id }),
              )}
              className={`group-album-card${selection.selectedIds.has(contentReferenceKey({ kind: 'group-album', groupCode, albumId: album.id })) ? ' is-selected' : ''}`}
              type="button"
              disabled={disabled}
              onClick={() => onOpenAlbum(album)}
              title={album.title || '未命名相册'}
              data-album-id={album.id}
            >
              <AlbumCover album={album} />
              <span>
                <strong>{album.title || '未命名相册'}</strong>
                <small>
                  <span className="weq-number weq-number-inherit">{album.photoCount ?? 0}</span> 项
                </small>
                {album.desc && <small>{album.desc}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
      {filtered.length > visibleCount && (
        <button type="button" className="group-album-more" onClick={onMore}>
          显示更多（<span className="weq-number weq-number-inherit">{visibleCount}</span> /{' '}
          <span className="weq-number weq-number-inherit">{filtered.length}</span>）
        </button>
      )}
    </>
  );
}

function AlbumCover({ album }: { album: GroupAlbumWire }): ReactElement {
  const document = useRenderDocument();
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
        src={resourceForRenderDocument(album.coverUrl, document)}
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
  hideNavigation = false,
  groupCode,
  onChanged,
}: {
  state: MediaState;
  onBack: () => void;
  hideNavigation?: boolean;
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
    return filterByName(
      kind === 'all' ? items : items.filter((item) => item.kind === kind),
      search,
      (item) => [item.fileName, item.uploader],
      (item, query) => `${item.fileName} ${item.uploader}`.toLocaleLowerCase().includes(query),
    );
  }, [items, search, kind]);
  const owner = { kind: 'group-albums' as const, container: groupCode };
  const references = useMemo(
    () =>
      new Map<string, ContentReference>(
        filtered.flatMap((media) => {
          if (!state.album) return [];
          const item: ContentReference = {
            kind: 'group-photo',
            groupCode,
            albumId: state.album.id,
            mediaKey: mediaKey(media),
            name: media.fileName || state.album.title,
          };
          return [[contentReferenceKey(item), item]];
        }),
      ),
    [filtered, groupCode, state.album],
  );
  const selection = useContentMultiSelect(owner, true, references);
  const multi = useMultiSelection({
    ids: [...references.keys()],
    selected: selection.selectedIds,
    onChange: selection.setSelectedIds,
    enabled: selection.selectionMode,
    onStart: () => selection.setSelectionMode(true),
    onExit: () => selection.setSelectionMode(false),
    anchorRef: selection.anchorRef,
  });
  const previews = useMemo<PreviewMedia[]>(
    () =>
      (preview?.items ?? []).map((item) => {
        const full = item.originalUrl || item.previewUrl;
        return {
          key: mediaKey(item),
          kind: item.kind === 'video' && item.originalUrl ? 'video' : 'image',
          isLivePhoto:
            item.isLivePhoto === true && item.kind === 'video' && Boolean(item.originalUrl),
          saveLabel: item.kind === 'video' && !item.originalUrl ? '保存视频封面' : undefined,
          src: full ? albumMediaUrl(full) : '',
          saveSource: {
            kind: 'url',
            url: albumMediaUrl(full),
            name:
              item.kind === 'video' && !item.originalUrl
                ? `${item.fileName || '视频'}-封面`
                : item.fileName,
          },
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
    <div {...multi.rootProps} className="group-album-media-view">
      <ContentReferenceToolbar
        owner={owner}
        selection={selection}
        loaded={[...references.keys()]}
      />
      <div ref={observeCompactToolbar} className="group-album-toolbar">
        {!hideNavigation ? (
          <button
            type="button"
            className="group-album-back"
            title="返回相册列表"
            aria-label="返回相册列表"
            onClick={onBack}
          >
            <ArrowLeft size={15} />
            <ToolbarLabel>相册</ToolbarLabel>
          </button>
        ) : null}
        <span>
          <NumericText>
            {state.status === 'loading' && !items.length ? '正在读取' : countText}
          </NumericText>
        </span>
        <div className="group-album-toolbar-actions">
          <button
            type="button"
            className="group-album-tool"
            title="上传图片或视频"
            aria-label="上传图片或视频"
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
          <GroupAlbumVideoUpload
            key={`${groupCode}:${state.album.id}`}
            groupId={Number(groupCode)}
            albumId={state.album.id}
            onChanged={onChanged}
          />
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
              selectionProps={multi.itemProps(
                contentReferenceKey({
                  kind: 'group-photo',
                  groupCode,
                  albumId: state.album!.id,
                  mediaKey: mediaKey(item),
                }),
              )}
              selected={selection.selectedIds.has(
                contentReferenceKey({
                  kind: 'group-photo',
                  groupCode,
                  albumId: state.album!.id,
                  mediaKey: mediaKey(item),
                }),
              )}
              onOpen={() => setPreview({ key: mediaKey(item), items: filtered })}
            />
          ))}
        </div>
      )}
      {!!filtered.length && (
        <p className="group-album-count" role="status">
          显示{' '}
          <span className="weq-number weq-number-inherit">
            {Math.min(visibleCount, filtered.length)}
          </span>{' '}
          / <span className="weq-number weq-number-inherit">{filtered.length}</span> 项
          {filtered.length !== items.length ? (
            <NumericText>{`，相册已读取 ${items.length} 项`}</NumericText>
          ) : (
            ''
          )}
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
        <MediaPreview
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
  return groupAlbumMediaKey(item);
}

function MediaThumbnail({
  item,
  onOpen,
  selectionProps,
  selected,
}: {
  item: AlbumMediaWire;
  onOpen: () => void;
  selectionProps?: HTMLAttributes<HTMLButtonElement>;
  selected?: boolean;
}): ReactElement {
  const document = useRenderDocument();
  const src = item.previewUrl || (item.kind === 'image' ? item.originalUrl : '');
  return (
    <button
      type="button"
      {...selectionProps}
      className={`group-album-media-card weq-media-frame${item.kind === 'video' ? ' is-video' : ''}${selected ? ' is-selected' : ''}`}
      onClick={onOpen}
      aria-label={`预览 ${item.fileName || (item.kind === 'video' ? '视频' : '图片')}`}
      title={item.fileName || '未命名媒体'}
    >
      {src ? (
        <ShimmerImage
          src={resourceForRenderDocument(albumMediaUrl(src), document)}
          alt="相册媒体"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="group-album-thumbnail-fallback">
          <Image size={24} />
          <small>暂无封面</small>
        </span>
      )}
      {item.kind === 'video' && item.isLivePhoto === true ? (
        <span className="group-album-media-play">实况</span>
      ) : item.kind === 'video' ? (
        <span className="group-album-media-play" aria-hidden>
          <Play size={18} />
        </span>
      ) : null}
      <span className="group-album-media-name">{item.fileName || '未命名媒体'}</span>
    </button>
  );
}
import { SegmentedControl } from './SegmentedControl';

import { EmptyState } from '../EmptyState';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowUpToLine,
  Download,
  Pencil,
  RefreshCw,
  Save,
  Smile,
  Trash2,
  X,
  Heart,
} from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { favEmojiItem, type EmojiItem } from '../../im-template/template/emojiPacks';
import { cn } from '../../im-template/template/classNames';
import { useRenderDocument } from '../../lib/renderDocument';
import { mediaUrl } from '../../lib/resourceUrl';
import { ConversationActionsMenu } from '../ConversationActionsMenu';
import { Modal } from '../Dialog';
import { useMediaSave } from '../MediaSaveControls.shared';
import { ActionIcon } from './shared';
import { useQQAction, withQQAccountScope } from './shared.shared';
import '../../styles/favorite-picker.css';

export interface PickerFavorite {
  id: string;
  hash: string;
  scope: string;
  bucket: string;
  oriFile: string | null;
  original?: { scope: string; bucket: string; file: string } | null;
  thumbFile: string | null;
  previewRevision?: string;
}

function FavoritePickerTabBody({
  favorites,
  loading,
  localReadStatus,
  onSelect,
  onChanged,
}: {
  favorites?: PickerFavorite[];
  loading: boolean;
  localReadStatus?: 'waiting' | 'failed';
  onSelect: (item: EmojiItem) => void;
  onChanged: () => Promise<void>;
}) {
  const action = useQQAction('favorite-picker');
  const inputId = useId();
  const gridRef = useRef<HTMLDivElement>(null);
  const Observer = useRenderDocument().defaultView?.IntersectionObserver;
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  const utils = trpc.useUtils();
  const save = useMediaSave();
  const online = trpc.account.qqActions.favorites.useQuery(
    action.binding!,
    useQQAutoRefresh(action.available),
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    item: EmojiItem;
    emojiId?: string;
    desc: string;
    position?: number;
  } | null>(null);
  const [edit, setEdit] = useState<{ emojiId: string; value: string } | null>(null);
  // 在线列表决定成员、备注与顺序，图片仍复用本地缓存；离线保留原来的选取能力。
  const rows = useMemo(() => {
    if (!online.data || !action.available)
      return (favorites ?? []).map((row) => ({
        ...row,
        emojiId: undefined,
        desc: '',
        position: undefined,
      }));
    const local = favorites && new Map(favorites.map((row) => [row.hash.toLowerCase(), row]));
    return online.data.flatMap(({ local: cached, ...info }) => {
      const current = local && cached ? (local.get(cached.hash.toLowerCase()) ?? cached) : cached;
      return current ? [{ ...current, ...info }] : [];
    });
  }, [online.data, action.available, favorites]);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !Observer) return;
    const intersecting = new Set<string>();
    // 以面板滚动区分批，不使用浏览器较大的屏外预取范围。
    const observer = new Observer(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.favoriteId!;
          if (entry.isIntersecting) intersecting.add(id);
          else intersecting.delete(id);
        }
        setVisible(new Set(intersecting));
      },
      { root: grid.parentElement },
    );
    for (const cell of grid.children) observer.observe(cell);
    return () => observer.disconnect();
  }, [Observer, rows]);
  const refresh = async () => {
    await utils.account.qqActions.favorites.invalidate();
    await onChanged();
  };
  const readback = async (matches: (rows: NonNullable<typeof online.data>) => boolean) => {
    const rows = await client.account.qqActions.favorites.query(action.binding!);
    return matches(rows);
  };
  const disabled = action.disabled || !menu?.emojiId;
  return (
    <>
      {online.error && (
        <div className="weq-favorite-picker-status" role="status">
          <span>收藏管理信息读取失败：{online.error.message}</span>
          <ActionIcon
            label="重试读取收藏管理信息"
            disabled={online.isFetching || !action.available}
            onClick={() => void online.refetch()}
          >
            <RefreshCw size={15} aria-hidden />
          </ActionIcon>
        </div>
      )}
      {loading && !rows.length ? (
        <div className={cn('emoji-state')}>加载中…</div>
      ) : localReadStatus && !rows.length && !(online.isSuccess && action.available) ? (
        <div className="weq-favorite-picker-status" role="status">
          <span>{localReadStatus === 'waiting' ? '等待连接电脑' : '收藏表情加载失败'}</span>
          <ActionIcon label="重试加载收藏表情" onClick={() => void onChanged()}>
            <RefreshCw size={15} aria-hidden />
          </ActionIcon>
        </div>
      ) : !rows.length ? (
        <EmptyState compact icon={<Heart />} title="还没有可用的收藏表情" />
      ) : null}
      <div ref={gridRef} className={cn('emoji-grid emoji-big-grid')}>
        {rows.map((row) => {
          const file = row.thumbFile ?? row.oriFile;
          if (!file) return null;
          const name = row.desc || row.hash;
          const variant = row.thumbFile ? 'thumb' : 'ori';
          const item = () =>
            row.original
              ? favEmojiItem(
                  row.original.scope,
                  row.original.bucket,
                  'ori',
                  row.original.file,
                  name,
                )
              : favEmojiItem(row.scope, row.bucket, variant, file, name);
          // 版本只用于网格预览，草稿与保存仍引用未经修改的原图地址。
          const src =
            !Observer || visible.has(row.id)
              ? mediaUrl('cemoji', {
                  scope: row.scope,
                  bucket: row.bucket,
                  v: variant,
                  file,
                  ...(row.previewRevision ? { previewRevision: row.previewRevision } : {}),
                })
              : null;
          const openMenu = (x: number, y: number) =>
            setMenu({
              x,
              y,
              item: item(),
              emojiId: row.emojiId,
              desc: row.desc,
              position: row.position,
            });
          return (
            <button
              key={row.id}
              type="button"
              title={name}
              aria-label={name}
              data-favorite-id={row.id}
              className={cn('emoji-cell is-sticker')}
              aria-haspopup="menu"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(item())}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openMenu(event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu(rect.left, rect.bottom);
              }}
            >
              {src && (
                <FavoritePreview
                  key={src}
                  src={src}
                  versioned={Boolean(row.previewRevision)}
                  lazy={!Observer}
                />
              )}
            </button>
          );
        })}
      </div>
      {menu && (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          label="收藏表情操作"
          onClose={() => setMenu(null)}
          actions={[
            {
              danger: 'outline',
              label: '删除',
              icon: <Trash2 size={15} />,
              disabled,
              reason: disabled ? '请连接 QQ 并读取收藏管理信息' : undefined,
              action: () => {
                const id = menu.emojiId;
                if (!id) return;
                void action.perform(
                  (binding) =>
                    client.account.qqActions.favorite.mutate({
                      ...binding,
                      action: 'delete',
                      emojiId: id,
                    }),
                  refresh,
                  `从 QQ 收藏中删除这张表情${menu.desc ? `「${menu.desc}」` : ''}？`,
                  {
                    danger: 'outline',
                    readback: () => readback((rows) => !rows.some((row) => row.emojiId === id)),
                  },
                );
              },
            },
            {
              label: '备注',
              icon: <Pencil size={15} />,
              disabled,
              action: () => {
                if (menu.emojiId) setEdit({ emojiId: menu.emojiId, value: menu.desc });
              },
            },
            {
              label: '移到最前',
              icon: <ArrowUpToLine size={15} />,
              disabled: disabled || menu.position === 1,
              action: () => {
                const id = menu.emojiId;
                if (!id) return;
                void action.perform(
                  (binding) =>
                    client.account.qqActions.favorite.mutate({
                      ...binding,
                      action: 'move',
                      emojiId: id,
                      position: 1,
                    }),
                  refresh,
                  undefined,
                  {
                    readback: () =>
                      readback((rows) =>
                        rows.some((row) => row.emojiId === id && row.position === 1),
                      ),
                  },
                );
              },
            },
            {
              label: '保存',
              icon: <Download size={15} />,
              separatorBefore: true,
              disabled: save.disabled || !menu.item.src,
              action: () => {
                if (menu.item.src)
                  void save.run({
                    kind: 'url',
                    url: menu.item.src,
                    name: menu.item.name,
                    mediaKind: 'emoji',
                  });
              },
            },
          ]}
        />
      )}
      {edit && (
        <Modal
          title="表情备注"
          labelledBy={`${inputId}-title`}
          width={360}
          centered
          onClose={() => {
            if (!action.pending) setEdit(null);
          }}
        >
          <form
            className="weq-favorite-picker-editor"
            onSubmit={(event) => {
              event.preventDefault();
              const submitted = edit;
              void action
                .perform(
                  (binding) =>
                    client.account.qqActions.favorite.mutate({
                      ...binding,
                      action: 'rename',
                      emojiId: submitted.emojiId,
                      desc: submitted.value,
                    }),
                  refresh,
                  undefined,
                  {
                    requireReadback: true,
                    readback: () =>
                      readback((rows) =>
                        rows.some(
                          (row) =>
                            row.emojiId === submitted.emojiId && row.desc === submitted.value,
                        ),
                      ),
                  },
                )
                .then((ok) => {
                  if (ok) setEdit(null);
                });
            }}
          >
            <label id={`${inputId}-title`} htmlFor={inputId}>
              表情备注
            </label>
            <input
              id={inputId}
              autoFocus
              maxLength={256}
              value={edit.value}
              disabled={action.pending}
              onChange={(event) => setEdit({ ...edit, value: event.target.value })}
            />
            <div>
              <ActionIcon
                label="取消修改表情备注"
                disabled={action.pending}
                onClick={() => setEdit(null)}
              >
                <X size={16} />
              </ActionIcon>
              <button
                type="submit"
                className="weq-set-iconbtn"
                aria-label="保存表情备注"
                title="保存表情备注"
                disabled={action.disabled}
              >
                <Save size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

const PREVIEW_CACHE_BYTES = 16 * 1024 * 1024;
const PREVIEW_CACHE_ENTRIES = 256;
const previewCache = new Map<string, Blob>();
let previewCacheBytes = 0;

/** 仅保留带文件版本的完整预览；WebKit 重新挂载时不一定会命中 HTTP 缓存。 */
function rememberPreview(src: string, blob: Blob) {
  if (!blob.size || blob.size > PREVIEW_CACHE_BYTES) return;
  previewCacheBytes -= previewCache.get(src)?.size ?? 0;
  previewCache.delete(src);
  previewCache.set(src, blob);
  previewCacheBytes += blob.size;
  for (const [oldest, bytes] of previewCache) {
    if (previewCache.size <= PREVIEW_CACHE_ENTRIES && previewCacheBytes <= PREVIEW_CACHE_BYTES)
      break;
    previewCache.delete(oldest);
    previewCacheBytes -= bytes.size;
  }
}

function FavoritePreview({
  src,
  versioned,
  lazy,
}: {
  src: string;
  versioned: boolean;
  lazy: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string>();
  const cancellable = !lazy && src.startsWith('/_media/');
  useEffect(() => {
    if (!cancellable) return;
    const request = new AbortController();
    let url: string | undefined;
    const show = (blob: Blob) => {
      if (request.signal.aborted) return;
      if (versioned) rememberPreview(src, blob);
      url = URL.createObjectURL(blob);
      setObjectUrl(url);
    };
    const cached = versioned ? previewCache.get(src) : undefined;
    if (cached) show(cached);
    // WebKit 移除屏外 <img> 时不一定中止下载，用可取消的读取给新视口腾出连接。
    else {
      void fetch(src, { signal: request.signal, priority: 'high' })
        .then((response) => {
          if (!response.ok) throw new Error(`Favorite preview: ${response.status}`);
          return response.blob();
        })
        .then(show)
        .catch(() => {
          if (!request.signal.aborted) setBroken(true);
        });
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
      else request.abort();
    };
  }, [cancellable, src, versioned]);
  return broken ? (
    <span className={cn('emoji-cell-fallback')} aria-hidden>
      <Smile size={22} strokeWidth={1.4} />
    </span>
  ) : (
    <img
      src={cancellable ? objectUrl : src}
      alt=""
      draggable={false}
      decoding="async"
      loading={lazy ? 'lazy' : undefined}
      fetchPriority={lazy ? undefined : 'high'}
      onError={() => setBroken(true)}
    />
  );
}

export const FavoritePickerTab = withQQAccountScope(FavoritePickerTabBody);

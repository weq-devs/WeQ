import { EmptyState } from '../EmptyState';
import { useId, useState } from 'react';
import {
  ArrowUpToLine,
  Download,
  Pencil,
  RotateCw,
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
import { ConversationActionsMenu } from '../ConversationActionsMenu';
import { Modal } from '../Dialog';
import { useMediaSave } from '../MediaSaveControls';
import { ActionIcon, useQQAction, withQQAccountScope } from './shared';
import '../../styles/favorite-picker.css';

export interface PickerFavorite {
  id: string;
  hash: string;
  scope: string;
  bucket: string;
  oriFile: string | null;
  original?: { scope: string; bucket: string; file: string } | null;
  thumbFile: string | null;
}

function FavoritePickerTabBody({
  favorites,
  loading,
  onSelect,
  onChanged,
}: {
  favorites: PickerFavorite[];
  loading: boolean;
  onSelect: (item: EmojiItem) => void;
  onChanged: () => Promise<void>;
}) {
  const action = useQQAction('favorite-picker');
  const inputId = useId();
  const [broken, setBroken] = useState<Set<string>>(new Set());
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
  const rows =
    online.data && action.available
      ? online.data.flatMap((row) => (row.local ? [{ ...row.local, ...row }] : []))
      : favorites.map((row) => ({ ...row, emojiId: undefined, desc: '', position: undefined }));
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
            <RotateCw size={15} />
          </ActionIcon>
        </div>
      )}
      {loading && !rows.length ? (
        <div className={cn('emoji-state')}>加载中…</div>
      ) : !rows.length ? (
        <EmptyState compact icon={<Heart />} title="还没有可用的收藏表情" />
      ) : null}
      <div className={cn('emoji-grid emoji-big-grid')}>
        {rows.map((row) => {
          const file = row.thumbFile ?? row.oriFile;
          if (!file) return null;
          const name = row.desc || row.hash;
          const preview = favEmojiItem(
            row.scope,
            row.bucket,
            row.thumbFile ? 'thumb' : 'ori',
            file,
            name,
          );
          const item = row.original
            ? favEmojiItem(row.original.scope, row.original.bucket, 'ori', row.original.file, name)
            : preview;
          const openMenu = (x: number, y: number) =>
            setMenu({
              x,
              y,
              item,
              emojiId: row.emojiId,
              desc: row.desc,
              position: row.position,
            });
          return (
            <button
              key={row.id}
              type="button"
              title={name}
              className={cn('emoji-cell is-sticker')}
              aria-haspopup="menu"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(item)}
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
              {broken.has(row.id) ? (
                <span className={cn('emoji-cell-fallback')}>
                  <Smile size={22} strokeWidth={1.4} />
                </span>
              ) : (
                <img
                  src={preview.src ?? undefined}
                  alt={name}
                  draggable={false}
                  onError={() => setBroken((previous) => new Set([...previous, row.id]))}
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
                  void save.run({ kind: 'url', url: menu.item.src, name: menu.item.name });
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
      {save.prompt}
    </>
  );
}

export const FavoritePickerTab = withQQAccountScope(FavoritePickerTabBody);

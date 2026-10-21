import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { mediaUrl } from '../../lib/resourceUrl';
import { ConversationActionsMenu } from '../ConversationActionsMenu';
import { useDialog } from '../Dialog';
import { useTabActive } from '../RetainedTabs';
import { FavoriteBundleExport } from './FavoriteBundleExport';
import '../../styles/group-content-management.css';
import '../../styles/qq-management.css';
import {
  ActionFeedback,
  ActionIcon,
  ImageAction,
  SaveAction,
  useQQAction,
  withQQAccountScope,
} from './shared';

function FavoriteActionsBody() {
  const a = useQQAction('favorites');
  const confirm = useDialog((s) => s.confirm);
  const [adding, setAdding] = useState(false);
  const [picture, setPicture] = useState<{ path: string; fileName: string } | null>(null);
  const autoRefresh = useQQAutoRefresh(a.available);
  const list = trpc.account.qqActions.favorites.useQuery({ ...a.binding! }, autoRefresh);
  const refresh = async () => {
    const r = await list.refetch();
    if (r.error) throw r.error;
  };
  return (
    <section className="weq-qq-actions weq-favorite-management" aria-label="QQ 收藏表情管理">
      <div className="weq-content-toolbar">
        <h3>收藏表情</h3>
        <div>
          <span>{list.data?.length ?? 0} 项</span>
          <FavoriteBundleExport
            binding={a.binding}
            disabled={a.disabled || list.isLoading || Boolean(list.error)}
          />
          <ActionIcon
            label="新建收藏表情"
            disabled={a.disabled || adding}
            onClick={() => setAdding(true)}
          >
            <Plus size={16} />
          </ActionIcon>
        </div>
      </div>
      <div className="weq-qq-action-form">
        {adding && (
          <div className="weq-qq-action-bar weq-favorite-add" aria-label="添加收藏表情编辑器">
            <ImageAction
              disabled={a.disabled}
              onClick={() =>
                void a.pickImage().then((f) => {
                  if (f) setPicture(f);
                })
              }
            />
            <span>{picture?.fileName}</span>
            <SaveAction
              label="添加收藏表情"
              disabled={a.disabled || !picture}
              onClick={() => {
                if (picture) {
                  const submitted = picture;
                  let accepted = false;
                  void a.perform(
                    async (b) => {
                      const result = await client.account.qqActions.favorite.mutate({
                        ...b,
                        action: 'add',
                        path: submitted.path,
                      });
                      accepted = result.state === 'accepted' || result.state === 'confirmed';
                      return result;
                    },
                    async () => {
                      if (accepted) {
                        setPicture(null);
                        setAdding(false);
                      }
                      await refresh();
                    },
                  );
                }
              }}
            />
            <ActionIcon
              label="取消添加表情"
              disabled={a.pending}
              onClick={() =>
                void (async () => {
                  if (picture && !(await confirm('放弃添加表情', '放弃当前选中的图片？'))) return;
                  setPicture(null);
                  setAdding(false);
                })()
              }
            >
              <X size={16} />
            </ActionIcon>
          </div>
        )}
        {list.isLoading && <p role="status">读取收藏表情中…</p>}
        {list.error && (
          <div className="weq-qq-action-bar">
            <p role="alert">{list.error.message}</p>
            <ActionIcon
              label="重试读取收藏表情"
              disabled={list.isFetching || !a.available}
              onClick={() => void list.refetch()}
            >
              <RotateCw size={16} />
            </ActionIcon>
          </div>
        )}
        {list.data?.length === 0 && <p>暂无收藏表情</p>}
        <ul className="weq-qq-action-list">
          {list.data?.map((f) => (
            <li key={f.emojiId}>
              {f.local && (
                <img
                  className="weq-qq-favorite-preview"
                  src={mediaUrl('cemoji', {
                    scope: f.local.scope,
                    bucket: f.local.bucket,
                    v: f.local.thumbFile ? 'thumb' : 'ori',
                    file: f.local.thumbFile || f.local.oriFile || '',
                  })}
                  alt={f.desc || '收藏表情'}
                />
              )}
              <FavoriteRow
                emojiId={f.emojiId}
                desc={f.desc}
                position={f.position}
                count={list.data.length}
                onChanged={refresh}
              />
            </li>
          ))}
        </ul>
        <ActionFeedback action={a} />
      </div>
    </section>
  );
}
export const FavoriteActions = withQQAccountScope(FavoriteActionsBody);
function FavoriteRow({
  emojiId,
  desc,
  position,
  count,
  onChanged,
}: {
  emojiId: string;
  desc: string;
  position: number;
  count: number;
  onChanged: () => Promise<void>;
}) {
  const a = useQQAction(`favorite:${emojiId}`);
  const active = useTabActive();
  const confirm = useDialog((s) => s.confirm);
  const [draft, setDraft] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!active) setMenu(null);
  }, [active]);
  const value = draft ?? desc;
  return (
    <div
      className="weq-qq-favorite-row"
      onContextMenu={(event) => {
        if (
          a.disabled ||
          (event.target instanceof Element && event.target.closest('input, textarea'))
        )
          return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="weq-favorite-row-heading">
        <span>{desc || '未命名表情'}</span>
        <button
          type="button"
          className="weq-set-iconbtn"
          aria-label="表情操作"
          title="表情操作"
          disabled={a.disabled}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom });
          }}
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
      {draft !== null && (
        <div className="weq-favorite-row-editor">
          <input
            aria-label="表情备注"
            value={value}
            maxLength={256}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="weq-qq-action-bar">
            <SaveAction
              label="保存表情备注"
              disabled={a.disabled || value === desc}
              onClick={() => {
                let accepted = false;
                void a.perform(
                  async (b) => {
                    const result = await client.account.qqActions.favorite.mutate({
                      ...b,
                      action: 'rename',
                      emojiId,
                      desc: value,
                    });
                    accepted = result.state === 'accepted' || result.state === 'confirmed';
                    return result;
                  },
                  async () => {
                    if (accepted) setDraft((current) => (current === value ? null : current));
                    await onChanged();
                  },
                );
              }}
            />
            <ActionIcon
              label="取消修改表情备注"
              disabled={a.pending}
              onClick={() =>
                void (async () => {
                  if (
                    value !== desc &&
                    !(await confirm('放弃修改备注', '放弃当前未保存的表情备注？'))
                  )
                    return;
                  setDraft(null);
                })()
              }
            >
              <X size={15} />
            </ActionIcon>
          </div>
        </div>
      )}
      {menu && active && (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          label="表情操作"
          onClose={() => setMenu(null)}
          actions={[
            {
              label: '修改表情备注',
              icon: <Pencil size={15} />,
              disabled: a.disabled,
              action: () => setDraft((current) => current ?? desc),
            },
            {
              label: '上移表情',
              icon: <ArrowUp size={15} />,
              disabled: a.disabled || position <= 1,
              action: () =>
                void a.perform(
                  (b) =>
                    client.account.qqActions.favorite.mutate({
                      ...b,
                      action: 'move',
                      emojiId,
                      position: position - 1,
                    }),
                  onChanged,
                ),
            },
            {
              label: '下移表情',
              icon: <ArrowDown size={15} />,
              disabled: a.disabled || position >= count,
              action: () =>
                void a.perform(
                  (b) =>
                    client.account.qqActions.favorite.mutate({
                      ...b,
                      action: 'move',
                      emojiId,
                      position: position + 1,
                    }),
                  onChanged,
                ),
            },
            {
              label: '删除收藏表情',
              icon: <Trash2 size={15} />,
              disabled: a.disabled,
              separatorBefore: true,
              action: () =>
                void a.perform(
                  (b) =>
                    client.account.qqActions.favorite.mutate({ ...b, action: 'delete', emojiId }),
                  onChanged,
                  `从 QQ 收藏中删除这张表情${desc ? `「${desc}」` : ''}？`,
                ),
            },
          ]}
        />
      )}
      <ActionFeedback action={a} />
    </div>
  );
}

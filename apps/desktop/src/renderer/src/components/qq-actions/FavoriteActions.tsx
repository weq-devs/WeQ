import { useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { mediaUrl } from '../../lib/resourceUrl';
import {
  ActionFeedback,
  ActionIcon,
  ImageAction,
  SaveAction,
  useQQAction,
  withQQAccountScope,
} from './shared';

function FavoriteActionsBody() {
  const a = useQQAction('favorites'),
    [open, setOpen] = useState(false);
  const [picture, setPicture] = useState<{ path: string; fileName: string } | null>(null);
  const autoRefresh = useQQAutoRefresh(open && a.available);
  const list = trpc.account.qqActions.favorites.useQuery({ ...a.binding! }, autoRefresh);
  const refresh = async () => {
    const r = await list.refetch();
    if (r.error) throw r.error;
  };
  return (
    <details className="weq-qq-actions" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>QQ 收藏表情管理</summary>
      <div className="weq-qq-action-form">
        <div className="weq-qq-action-bar">
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
              if (picture)
                void a.perform(
                  (b) =>
                    client.account.qqActions.favorite.mutate({
                      ...b,
                      action: 'add',
                      path: picture.path,
                    }),
                  async () => {
                    setPicture(null);
                    await refresh();
                  },
                );
            }}
          />
        </div>
        {list.isLoading && <p role="status">读取收藏表情中…</p>}
        {list.error && <p role="alert">{list.error.message}</p>}
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
    </details>
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
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? desc;
  return (
    <div className="weq-qq-favorite-row">
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
          onClick={() =>
            void a.perform(
              (b) =>
                client.account.qqActions.favorite.mutate({
                  ...b,
                  action: 'rename',
                  emojiId,
                  desc: value,
                }),
              async () => {
                await onChanged();
                setDraft((current) => (current === value ? null : current));
              },
            )
          }
        />
        <ActionIcon
          label="上移表情"
          disabled={a.disabled || position <= 1}
          onClick={() =>
            void a.perform(
              (b) =>
                client.account.qqActions.favorite.mutate({
                  ...b,
                  action: 'move',
                  emojiId,
                  position: position - 1,
                }),
              onChanged,
            )
          }
        >
          <ArrowUp size={15} />
        </ActionIcon>
        <ActionIcon
          label="下移表情"
          disabled={a.disabled || position >= count}
          onClick={() =>
            void a.perform(
              (b) =>
                client.account.qqActions.favorite.mutate({
                  ...b,
                  action: 'move',
                  emojiId,
                  position: position + 1,
                }),
              onChanged,
            )
          }
        >
          <ArrowDown size={15} />
        </ActionIcon>
        <ActionIcon
          label="删除收藏表情"
          disabled={a.disabled}
          onClick={() =>
            void a.perform(
              (b) => client.account.qqActions.favorite.mutate({ ...b, action: 'delete', emojiId }),
              onChanged,
              `从 QQ 收藏中删除这张表情${desc ? `「${desc}」` : ''}？`,
            )
          }
        >
          <Trash2 size={15} />
        </ActionIcon>
      </div>
      <ActionFeedback action={a} />
    </div>
  );
}

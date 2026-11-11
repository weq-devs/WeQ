import { SmilePlus } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useQQAction } from './shared';

export function MessageFavoriteEmojiAction({
  url,
  onClose,
  mediaLabel,
}: {
  url: string;
  onClose: () => void;
  mediaLabel?: string;
}) {
  const action = useQQAction(`favorite-message:${url}`);
  const utils = trpc.useUtils();
  async function add() {
    let emojiId = '';
    const completed = await action.perform(
      async (binding) => {
        const result = await client.account.qqActions.favoriteFromMedia.mutate({ ...binding, url });
        emojiId = result.emojiId;
        return result;
      },
      async () => {
        await Promise.all([
          utils.account.qqActions.favorites.invalidate(),
          utils.account.emojiPanel.overview.invalidate(),
        ]);
      },
      undefined,
      {
        readback: async () => {
          const ids = await client.account.qqActions.favoriteIds.query({ ...action.binding! });
          return ids.includes(emojiId);
        },
        readbackSuccessText: '已添加到表情',
      },
    );
    if (completed) onClose();
  }
  return (
    <button
      type="button"
      aria-label="添加到表情"
      title={
        !action.available
          ? 'QQ 在线并启用完整功能后可添加到表情'
          : action.pending
            ? '正在添加到表情'
            : mediaLabel
              ? `添加到表情：${mediaLabel}`
              : '添加到表情'
      }
      aria-busy={action.pending}
      disabled={action.disabled}
      onClick={() => void add()}
    >
      <SmilePlus size={17} />
      <span>添加到表情</span>
    </button>
  );
}

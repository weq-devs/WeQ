import { SmilePlus } from 'lucide-react';
import { useRenderDocument } from '../../lib/renderDocument';
import { MessageMenuButton } from '../MessageMenuButton';
import { client, trpc } from '../../trpc/client';
import { useDialog } from '../Dialog.shared';
import { useQQAction } from './shared.shared';

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
  const ownerDocument = useRenderDocument();
  const confirm = useDialog((state) => state.confirm);
  async function add() {
    const binding = action.binding;
    if (!binding) return;
    let result: Awaited<ReturnType<typeof client.account.qqActions.favoriteFromMedia.mutate>>;
    let position = 0;
    const refresh = async (moveConfirmed = false) => {
      const { emojiId, local } = result;
      if (position && (local || moveConfirmed)) {
        await Promise.all([
          utils.account.qqActions.favorites.cancel(binding),
          local && utils.account.emojiPanel.favorites.cancel(),
        ]);
        const account = utils.account.getAccountConfig.getData();
        if (
          account?.uin !== binding.expectedAccountUin ||
          account.configId !== binding.expectedAccountConfigId
        )
          return;
        utils.account.qqActions.favorites.setData(binding, (rows) => {
          if (!rows) return undefined;
          const existing = rows.find((row) => row.emojiId === emojiId);
          const updated = {
            emojiId,
            desc: existing?.desc ?? '',
            position,
            local: local ?? existing?.local ?? null,
          };
          if (existing && !moveConfirmed)
            return rows.map((row) => (row === existing ? { ...row, local: updated.local } : row));
          const next = rows.filter((row) => row !== existing);
          next.splice(position - 1, 0, updated);
          return next.map((row, index) => ({ ...row, position: index + 1 }));
        });
        if (local)
          utils.account.emojiPanel.favorites.setData(undefined, (rows = []) => {
            const hash = local.hash.toLowerCase();
            if (moveConfirmed)
              return [local, ...rows.filter((row) => row.hash.toLowerCase() !== hash)];
            return rows.some((row) => row.hash.toLowerCase() === hash)
              ? rows.map((row) => (row.hash.toLowerCase() === hash ? local : row))
              : [local, ...rows];
          });
      }
      await Promise.all([
        utils.account.qqActions.favorites.invalidate(binding),
        utils.account.emojiPanel.overview.invalidate(),
        utils.account.emojiPanel.favorites.invalidate(),
      ]);
    };
    const completed = await action.perform(
      async (binding) => {
        result = await client.account.qqActions.favoriteFromMedia.mutate({ ...binding, url });
        return result;
      },
      refresh,
      undefined,
      {
        readback: async () => {
          if (result.existingPosition > 0) {
            position = result.existingPosition;
            return true;
          }
          const ids = await client.account.qqActions.favoriteIds.query(binding);
          position = ids.indexOf(result.emojiId) + 1;
          return position > 0;
        },
        readbackSuccessText: () => (result.alreadyExists ? null : '已添加到表情'),
      },
    );
    if (!completed) return;
    if (
      result!.alreadyExists &&
      position > 1 &&
      (await confirm('这张表情已收藏', '要把它移到 QQ 收藏表情的最前面吗？', {
        ownerDocument,
        tone: 'info',
        okLabel: '移到最前',
        cancelLabel: '保留原位',
      }))
    ) {
      let moveConfirmed = false;
      let moveSubmitted: boolean | undefined;
      await action.perform(
        async (binding) => {
          const outcome = await client.account.qqActions.favorite.mutate({
            ...binding,
            action: 'move',
            emojiId: result.emojiId,
            position: 1,
          });
          moveSubmitted = outcome.moveSubmitted;
          return outcome;
        },
        () => refresh(moveConfirmed),
        undefined,
        {
          readback: async () => {
            moveConfirmed =
              moveSubmitted === false ||
              (await client.account.qqActions.favoriteIds.query(binding))[0] === result.emojiId;
            if (moveConfirmed) position = 1;
            return moveConfirmed;
          },
          readbackSuccessText: () => (moveSubmitted ? '已移到最前' : null),
        },
      );
    }
    onClose();
  }
  return (
    <MessageMenuButton
      type="button"
      aria-label="添加到表情"
      title={
        !action.available
          ? 'QQ 在线并启用 QQ 在线能力后可添加到表情'
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
    </MessageMenuButton>
  );
}

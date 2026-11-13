import type { ReactNode } from 'react';
import { client } from '../trpc/client';
import { QzoneForwardDialog } from './QzoneForwardDialog';
import { useQQAction } from './qq-actions/shared';

/** 仅打开转发框时建立写入会话，不给信息流每条动态增加账号轮询。 */
export function QzonePostForwardDialog({
  selfUin,
  hostUin,
  tid,
  previousContent,
  onClose,
  children,
}: {
  selfUin: string;
  hostUin: string;
  tid: string;
  previousContent: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const action = useQQAction(`qzone-forward:${hostUin}:${tid}`);
  return (
    <QzoneForwardDialog
      previousContent={previousContent}
      onClose={onClose}
      disabled={action.disabled}
      submit={async (reason) => {
        const sentAt = Math.floor(Date.now() / 1000);
        let accepted = false;
        const completed = await action.perform(
          async (binding) => {
            const result = await client.account.qqActions.qzoneForward.mutate({
              ...binding,
              hostUin,
              tid,
              reason,
            });
            accepted = result.state === 'accepted' || result.state === 'confirmed';
            return result;
          },
          undefined,
          undefined,
          {
            readback: async () => {
              const page = await client.account.qzone.posts.query({
                selfUin,
                hostUin: selfUin,
                offset: 0,
                requestId: crypto.randomUUID(),
              });
              return page.list.some(
                (entry) =>
                  entry.time >= sentAt - 5 &&
                  entry.content === reason &&
                  entry.repost?.uin === hostUin &&
                  entry.repost.tid === tid,
              );
            },
            readbackSuccessText: '转发已完成',
          },
        );
        if (!completed || !accepted) throw new Error('转发结果未确认，请核对后刷新。');
      }}
    >
      {children}
    </QzoneForwardDialog>
  );
}

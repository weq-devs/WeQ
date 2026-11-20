import { useDialog } from '../Dialog.shared';
import { openExternalLink } from '../../lib/openExternalLink';
import { useRenderDocument } from '../../lib/renderDocument';
import { qqContactCardUrl } from '../../im-template/template/arkCards';
import { client, trpc } from '../../trpc/client';
import { useQQAction } from './shared.shared';

export function useDeleteFriend(scope: string, options?: { passive?: boolean }) {
  const action = useQQAction(`delete-friend:${scope}`, 'all', options);
  const utils = trpc.useUtils();
  return {
    disabled: action.disabled,
    run(uid: string, name: string) {
      let confirmed = false;
      return action.perform(
        async (binding) => {
          const result = await client.account.qqActions.deleteFriend.mutate({
            ...binding,
            targetUid: uid,
          });
          confirmed = result.state === 'confirmed';
          return result;
        },
        () => utils.account.qqWrite.peerState.invalidate(),
        `删除好友「${name}」？本地聊天记录仍可查看。`,
        {
          danger: 'outline',
          profileUid: uid,
          readbackSuccessText: '已删除好友',
          requireReadback: true,
          readback: async () => confirmed,
        },
      );
    },
  };
}

export function useGroupExitActions(action: ReturnType<typeof useQQAction>) {
  const ownerDocument = useRenderDocument();
  const confirm = useDialog((state) => state.confirm);
  const showError = useDialog((state) => state.showError);
  const utils = trpc.useUtils();
  return {
    leave: {
      label: '退出群聊',
      disabled: action.disabled,
      run(groupId: number, name: string) {
        return action.perform(
          (binding) =>
            client.account.qqActions.groupSettings.mutate({ ...binding, groupId, action: 'leave' }),
          () => utils.account.qqActions.groupPermissions.invalidate(),
          `退出「${name}」（${groupId}）？退出后将无法接收该群的新消息。`,
          {
            danger: 'outline',
            readbackSuccessText: '已退出群聊',
            readback: async () => {
              if (!action.binding) return false;
              const status = await client.account.qqActions.groupPermissions.query({
                ...action.binding,
                groupId,
              });
              return status.joined === false;
            },
          },
        );
      },
    },
    disband: {
      label: '解散群聊',
      disabled: false,
      async run(groupId: number, name: string) {
        const proceed = await confirm(
          '解散群聊',
          `解散「${name}」（${groupId}）会影响所有群成员。请用群主账号在 QQ 的群设置中完成解散。`,
          { danger: 'outline', okLabel: '在 QQ 中打开群资料', ownerDocument },
        );
        if (!proceed) return;
        try {
          const result = await openExternalLink(
            qqContactCardUrl('group', groupId),
            ownerDocument.defaultView ?? undefined,
          );
          if (result.ok) return;
        } catch {
          // 没有可用的 QQ 链接处理器时，仍给出手动定位方式。
        }
        showError('无法打开 QQ 群资料', `请在 QQ 中搜索群号 ${groupId}，进入群设置完成解散。`, {
          ownerDocument,
        });
      },
    },
  };
}

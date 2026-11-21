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
  const utils = trpc.useUtils();
  function groupExit(disband: boolean) {
    return {
      label: disband ? '解散群聊' : '退出群聊',
      disabled: action.disabled,
      run(groupId: number, name: string) {
        return action.perform(
          (binding) =>
            client.account.qqActions.groupSettings.mutate({
              ...binding,
              groupId,
              action: 'leave',
              ...(disband ? { disband: true } : {}),
            }),
          () => utils.account.qqActions.groupPermissions.invalidate(),
          disband
            ? `解散「${name}」（${groupId}）？解散后，所有成员将退出该群。`
            : `退出「${name}」（${groupId}）？退出后将无法接收该群的新消息。`,
          {
            danger: 'outline',
            readbackSuccessText: disband ? '已解散群聊' : '已退出群聊',
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
    };
  }
  return { leave: groupExit(false), disband: groupExit(true) };
}

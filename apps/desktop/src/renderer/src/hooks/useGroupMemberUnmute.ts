import { useContext } from 'react';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from './useQQWriteSession';
import { RelationshipDirectoryContext } from '../lib/contactRelationship';
import { useDialog } from '../components/Dialog';
import type { GroupMemberRole } from '../im-template/template/types';

export function canModerateMember(
  role?: string | null,
  targetRole?: GroupMemberRole | null,
  isSelf = false,
) {
  return (
    !isSelf &&
    (role === 'owner'
      ? targetRole === 'admin' || targetRole === 'member'
      : role === 'admin' && targetRole === 'member')
  );
}

/** 名片与右键菜单共用绑定账号、确认弹窗及操作后的成员读回。 */
export function useGroupMemberUnmute({
  groupCode,
  uid,
  name,
  role,
  muteUntil,
}: {
  groupCode: string;
  uid: string;
  name: string;
  role?: GroupMemberRole;
  muteUntil?: string | null;
}) {
  const session = useQQWriteSession(`unmute:${groupCode}:${uid}`, true);
  const directory = useContext(RelationshipDirectoryContext);
  const group = directory?.groups.get(groupCode);
  const canModerate =
    group?.listed === true && canModerateMember(group.role, role, directory?.selfUid === uid);
  const valid = /^[1-9]\d*$/.test(groupCode) && /^u_[A-Za-z0-9_-]+$/.test(uid);
  const details = trpc.account.qqWrite.memberDetails.useQuery(
    { ...session.binding!, groupId: Number(groupCode), uid },
    { enabled: valid && canModerate && session.available, staleTime: 0 },
  );
  const mutation = trpc.account.qqWrite.groupMemberMute.useMutation();
  const until =
    details.data?.uid === uid ? details.data.muteUntil * 1000 : Date.parse(muteUntil ?? '');
  const muted = until > Date.now();
  const available = valid && canModerate && muted && session.available && !session.busy;
  async function unmute(ownerDocument?: Document) {
    if (!available) return false;
    if (
      !(await useDialog
        .getState()
        .confirm('解除禁言', `确定解除 ${name} 的禁言？`, { okLabel: '解除禁言', ownerDocument }))
    )
      return false;
    return session.run(
      (binding) =>
        mutation.mutateAsync({
          ...binding,
          groupId: Number(groupCode),
          targetUid: uid,
          duration: 0,
        }),
      undefined,
      {
        groupCode,
        memberUid: uid,
        readbackSuccessText: '已解除禁言',
        readback: async () => {
          const result = await details.refetch();
          if (result.error) throw result.error;
          return result.data?.uid === uid && result.data.muteUntil * 1000 <= Date.now();
        },
      },
    );
  }
  return { muted, until, available, canModerate, busy: session.busy, unmute };
}

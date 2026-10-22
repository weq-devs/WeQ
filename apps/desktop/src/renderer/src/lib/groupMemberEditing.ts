import type { GroupMemberRole } from '../im-template/template/types';

/** 编辑入口的展示规则；实际写入仍由账号绑定和 QQ 服务端权限约束。 */
export function groupMemberEditing(
  role: GroupMemberRole | null | undefined,
  targetRole: GroupMemberRole | null | undefined,
  isSelf = false,
) {
  return {
    card:
      isSelf ||
      role === 'owner' ||
      (role === 'admin' && (targetRole === 'admin' || targetRole === 'member')),
    title: role === 'owner',
  };
}

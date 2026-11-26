// @ts-nocheck
import type { GroupConversation, User } from './types';

export function displayUserName(user: Pick<User, 'displayName' | 'username'>) {
  return user.displayName || user.username;
}

export function displayGroupName(
  group: Pick<GroupConversation['group'], 'name' | 'remark'>,
): string {
  return group.remark?.trim() || group.name;
}

export { displayGroupMemberName } from '../../../../shared/group_member_order';

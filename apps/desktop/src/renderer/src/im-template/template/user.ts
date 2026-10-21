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

/** QQ group display name: group card, local friend remark, then account nickname. */
export function displayGroupMemberName(
  card: string | null | undefined,
  remark: string | null | undefined,
  nick: string | null | undefined,
  fallback: string,
): string {
  return card?.trim() || remark?.trim() || nick?.trim() || fallback;
}

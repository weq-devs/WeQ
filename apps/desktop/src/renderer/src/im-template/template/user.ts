// @ts-nocheck
import type { User } from './types';

export function displayUserName(user: Pick<User, 'displayName' | 'username'>) {
  return user.displayName || user.username;
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

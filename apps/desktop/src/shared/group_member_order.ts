import { FRIEND_SORTS } from '@weq/service/client-preferences';

export const GROUP_MEMBER_SORTS = {
  displayName: '群内显示昵称',
  joinedAt: '入群时间',
  lastSpeakAt: '最后发言',
  memberLevel: '群等级',
  ...FRIEND_SORTS,
} as const;

export const GROUP_MEMBER_PRIORITIZE_ADMINS_DEFAULT = true;

export type GroupMemberSort = keyof typeof GROUP_MEMBER_SORTS;
export type GroupMemberSortView = {
  descending?: boolean;
  prioritizeAdmins?: boolean;
};

export const GROUP_MEMBER_ONLINE_SORTS = [
  'likeCount',
  'level',
  'addedAt',
  'commonFriends',
  'commonGroups',
  'energy',
] as const;
export type GroupMemberOnlineSort = (typeof GROUP_MEMBER_ONLINE_SORTS)[number];

export function isGroupMemberOnlineSort(sort: GroupMemberSort): sort is GroupMemberOnlineSort {
  return GROUP_MEMBER_ONLINE_SORTS.some((field) => field === sort);
}

export function groupMemberDefaultDescending(sort: GroupMemberSort) {
  return !['displayName', 'remark', 'nick', 'uin', 'birthday'].includes(sort);
}

export const groupMemberCollator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', {
  numeric: true,
  sensitivity: 'base',
});

export type GroupMemberSortDetail = { text: string; title?: string };

export type GroupMemberOrderValue = string | number | null;

export function compareGroupMemberValues(
  a: GroupMemberOrderValue,
  b: GroupMemberOrderValue,
  descending: boolean,
) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const order =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : groupMemberCollator.compare(String(a), String(b));
  return descending ? -order : order;
}

/** 群名片、本地好友备注、QQ 昵称依次回退。 */
export function displayGroupMemberName(
  card: string | null | undefined,
  remark: string | null | undefined,
  nick: string | null | undefined,
  fallback: string,
) {
  return card?.trim() || remark?.trim() || nick?.trim() || fallback;
}

export function groupMemberRoleOrder(owner: boolean, admin: boolean) {
  return owner ? 0 : admin ? 1 : 2;
}

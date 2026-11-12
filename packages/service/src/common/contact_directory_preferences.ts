export const FRIEND_SORTS = {
  remark: '备注',
  nick: '昵称',
  uin: 'QQ 号',
  age: '年龄',
  birthday: '生日',
  intimacy: '亲密度',
  likeCount: '获赞数',
  level: 'QQ 等级',
  addedAt: '添加时间',
  commonFriends: '共同好友数',
  commonGroups: '共同群聊数',
  sigUpdateTime: '签名更新时间',
  lastMessageAt: '最近联系时间',
  energy: 'QQ 能量值',
  affinity: 'AI 好感度',
};
export const FRIEND_GROUPS = {
  none: '不分组',
  qq: 'QQ 分组',
  birthYear: '出生年份',
  constellation: '星座',
  gender: '性别',
  location: '所在地',
  relation: '亲密关系',
  direction: '添加方向',
  occupation: '职业',
  type: '关系／类型',
  source: '添加来源',
  school: '学校',
};
export const GROUP_SORTS = {
  remark: '备注',
  name: '群名',
  groupCode: '群号',
  memberCount: '人数',
  activityScore: '活跃度',
  createTime: '创建时间',
  friendCount: '群内好友数',
  lastMessageAt: '最近消息时间',
  lastSpokeAt: '我最近发言',
  joinedAt: '我的入群时间',
};
export const GROUP_GROUPS = {
  none: '不分组',
  notify: '消息提醒方式',
  identity: '我的身份',
  capacity: '群容量',
  freezeState: '冻结状态',
  grade: 'grade',
};
export const accountOrderDefaults = {
  friends: { grouping: 'qq', sort: 'remark', descending: false },
  groups: { grouping: 'notify', sort: 'remark', descending: false },
  refreshRange: 'older24h',
} as const;

export function isDirectoryPreference(
  kind: 'friends' | 'groups',
  value: unknown,
): value is { grouping: string; sort: string; descending: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.grouping === 'string' &&
    typeof row.sort === 'string' &&
    typeof row.descending === 'boolean' &&
    Object.hasOwn(kind === 'friends' ? FRIEND_GROUPS : GROUP_GROUPS, row.grouping) &&
    Object.hasOwn(kind === 'friends' ? FRIEND_SORTS : GROUP_SORTS, row.sort)
  );
}

export function normalizeContactOrder(value: Record<string, unknown> = {}) {
  const part = (kind: 'friends' | 'groups') => {
    const row = value[kind];
    return isDirectoryPreference(kind, row)
      ? { grouping: row.grouping, sort: row.sort, descending: row.descending }
      : { ...accountOrderDefaults[kind] };
  };
  return {
    friends: part('friends'),
    groups: part('groups'),
    refreshRange: ['older24h', 'all', 'none'].includes(String(value.refreshRange))
      ? (value.refreshRange as string)
      : accountOrderDefaults.refreshRange,
  };
}

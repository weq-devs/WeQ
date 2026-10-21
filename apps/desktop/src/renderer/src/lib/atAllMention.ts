export interface AtAllMentionState {
  selectable: boolean;
  summary: string;
  detail: string;
}

export function atAllMentionState(input: {
  online: boolean;
  loading?: boolean;
  error?: boolean;
  data?: {
    role: string | null;
    canManage: boolean;
    quota: { canAtAll: boolean; remainCountForUin: number; remainCountForGroup: number } | null;
  };
}): AtAllMentionState {
  const unavailable = (summary: string, detail = summary) => ({
    selectable: false,
    summary,
    detail,
  });
  if (input.loading) return unavailable('读取中', '正在核对权限与全体成员额度');
  if (input.error) return unavailable('读取失败', '额度读取失败，暂不可用');
  if (!input.online) return unavailable('离线', 'QQ 离线或完整功能不可用，无法核实额度');
  const data = input.data;
  if (!data?.role) return unavailable('权限未知');
  if (!data.canManage || (data.role !== 'owner' && data.role !== 'admin'))
    return unavailable('仅群主／管理员');
  const quota = data.quota;
  if (
    !quota ||
    !Number.isSafeInteger(quota.remainCountForUin) ||
    quota.remainCountForUin < 0 ||
    !Number.isSafeInteger(quota.remainCountForGroup) ||
    quota.remainCountForGroup < 0
  )
    return unavailable('额度未知');
  const summary = `个人 ${quota.remainCountForUin} · 群 ${quota.remainCountForGroup}`;
  const selectable = quota.canAtAll && quota.remainCountForUin > 0 && quota.remainCountForGroup > 0;
  return {
    selectable,
    summary,
    detail: `${selectable ? '可用' : '不可用'}；本账号剩余 ${quota.remainCountForUin} 次，群剩余 ${quota.remainCountForGroup} 次`,
  };
}

export function nextMentionIndex(
  members: readonly { id: string }[],
  current: number,
  direction: 1 | -1,
  allSelectable: boolean,
): number {
  const start = current < 0 && direction < 0 ? 0 : current;
  for (let step = 1; step <= members.length; step++) {
    const index = (((start + direction * step) % members.length) + members.length) % members.length;
    if (members[index]?.id !== 'all' || allSelectable) return index;
  }
  return -1;
}

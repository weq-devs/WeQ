import type { ContactRequest, GroupJoinRequest } from '../im-template/template/types';

export function groupNoticeId(notify: { groupUin: string; operatedUid: string; msgTime: number }) {
  return `group-notify:${notify.groupUin}:${notify.operatedUid}:${notify.msgTime}`;
}

export type NoticeOperation = {
  kind: 'friend' | 'doubtFriend' | 'group' | 'filteredGroup';
  token: string;
  uid: string;
  uin: string;
  groupId: string;
  name: string;
  groupName: string;
  message: string;
};

/** 同一个人的多次申请只把最新一张待处理卡片绑定到当前在线请求。 */
export function bindNoticeOperations<T extends ContactRequest | GroupJoinRequest>(
  notices: T[],
  operations: NoticeOperation[],
): { cards: Array<{ notice: T; operation?: NoticeOperation }>; remaining: NoticeOperation[] } {
  const remaining = new Set(operations);
  const cards = notices.map((notice) => ({
    notice,
    operation: undefined as NoticeOperation | undefined,
  }));
  for (const card of [...cards].sort((a, b) =>
    b.notice.createdAt.localeCompare(a.notice.createdAt),
  )) {
    const n = card.notice;
    const candidate = [...remaining].find((op) => {
      const sameUser =
        (Boolean(op.uid) && op.uid === n.user.id) ||
        (Boolean(op.uin) && op.uin === n.user.identityValue);
      if ('direction' in n)
        return sameUser && n.direction === 'incoming' && n.status === 'pending' && !op.groupId;
      return (
        sameUser &&
        n.action === '申请加入' &&
        n.handleState === 'pending' &&
        op.groupId === n.group.id &&
        Boolean(n.isDoubt) === (op.kind === 'filteredGroup')
      );
    });
    if (candidate) {
      card.operation = candidate;
      remaining.delete(candidate);
    }
  }
  return { cards, remaining: [...remaining] };
}

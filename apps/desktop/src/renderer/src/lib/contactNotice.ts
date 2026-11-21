import { eventTimeFormatter } from '@weq/time';
import type { ContactRequest, GroupJoinRequest } from '../im-template/template/types';
import { notificationInlineText } from '../../../shared/notification_copy';

export function friendNoticeCopy(notice: ContactRequest) {
  const name = notificationInlineText(notice.user.displayName, 24);
  const person = !name || name === notice.user.id ? '对方' : name;
  const title =
    notice.direction === 'incoming'
      ? notice.status === 'accepted'
        ? `已同意 ${person} 的好友申请`
        : notice.status === 'rejected'
          ? `已拒绝 ${person} 的好友申请`
          : notice.status === 'cancelled'
            ? `${person}已撤回好友申请`
            : `${person}申请加你为好友`
      : notice.status === 'accepted'
        ? `${person}已同意你的好友申请`
        : notice.status === 'rejected'
          ? `${person}未同意你的好友申请`
          : `发给 ${person} 的好友申请`;
  return { title, summary: notificationInlineText(notice.message ?? '', 100) };
}

export function groupNoticeCopy(notice: GroupJoinRequest) {
  const name = notificationInlineText(notice.user.displayName, 20);
  const person = !name || name === notice.user.id ? '一位成员' : name;
  const group = notificationInlineText(notice.group.name, 28);
  const applying = notice.action === '申请加入';
  const title = applying ? `${person}申请加入群聊` : `${person}${notice.action}`;
  const status =
    applying && notice.handleState === 'agreed'
      ? '已同意'
      : applying && notice.handleState === 'refused'
        ? '已拒绝'
        : '';
  return {
    title,
    summary: [
      group,
      status,
      notificationInlineText(notice.message || notice.systemRemark || '', 100),
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

const noticeTime = eventTimeFormatter;

export function formatNoticeTimestamp(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? noticeTime.format(time) : '';
}

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

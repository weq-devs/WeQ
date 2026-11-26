import { eventTimeFormatter } from '@weq/time';
import type { ContactRequest, GroupJoinRequest, User } from '../im-template/template/types';
import { notificationInlineText } from '../../../shared/notification_copy';
import { groupNoticeSequenceId, type NoticeOperationWire } from '../../../shared/contact_notices';

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

export type NoticeOperation = NoticeOperationWire & {
  kind: 'friend' | 'doubtFriend' | 'group' | 'filteredGroup';
};

export type NoticeInbox = { operations: NoticeOperation[]; error?: string };

export type GroupNoticeInbox = NoticeInbox & {
  loading: boolean;
  onRefresh?: () => void;
  loadMoreNormal?: () => void;
  loadMoreFiltered?: () => void;
};

export function groupNoticeReadId(notice: Pick<GroupJoinRequest, 'id' | 'sequence' | 'isDoubt'>) {
  return notice.sequence && /^[1-9]\d{0,19}$/.test(notice.sequence)
    ? groupNoticeSequenceId(notice.sequence, Boolean(notice.isDoubt))
    : notice.id;
}

export function noticeBadgeList<T extends ContactRequest | GroupJoinRequest>(
  notices: T[],
  operations: NoticeOperation[],
  self?: Pick<User, 'uid' | 'identityValue'>,
) {
  const { remaining } = bindNoticeOperations(notices, operations);
  const legacyIds = new Map<string, string>();
  const ids: string[] = [];
  for (const notice of notices) {
    // 发出申请本身不提醒；对方处理后的结果仍按原有规则计入未读。
    if ('direction' in notice) {
      if (
        notice.direction === 'outgoing' &&
        (notice.status === 'pending' || notice.status === 'unknown')
      )
        continue;
    } else if (
      notice.action === '申请加入' &&
      (notice.handleState === 'pending' || notice.handleState === 'none') &&
      ((self?.uid && notice.user.id === self.uid) ||
        (self?.identityValue &&
          notice.user.identityLabel === 'QQ' &&
          notice.user.identityValue === self.identityValue))
    )
      continue;
    const id = 'direction' in notice ? notice.id : groupNoticeReadId(notice);
    if (id !== notice.id) legacyIds.set(id, notice.id);
    ids.push(id);
  }
  for (const { noticeId } of remaining) if (noticeId) ids.push(noticeId);
  return { ids, legacyIds };
}

export function confirmedGroupNoticeReads(
  ids: string[],
  normal?: string | null,
  filtered?: string | null,
) {
  const normalThrough = normal == null ? null : BigInt(normal);
  const filteredThrough = filtered == null ? null : BigInt(filtered);
  return new Set(
    ids.filter((id) => {
      const identity = /^group-notify-seq:(normal|filtered):(\d{1,20})$/.exec(id);
      if (!identity?.[2]) return false;
      const through = identity[1] === 'normal' ? normalThrough : filteredThrough;
      return through !== null && BigInt(identity[2]) <= through;
    }),
  );
}

export function latestNormalNoticeSequence(
  notices: GroupJoinRequest[],
  onlineOnly: NoticeOperation[],
): string | undefined {
  let latest = 0n;
  const sequences = [
    ...notices.filter((notice) => !notice.isDoubt).map((notice) => notice.sequence),
    ...onlineOnly.filter((notice) => notice.kind === 'group').map((notice) => notice.sequence),
  ];
  for (const sequence of sequences) {
    if (!sequence || !/^[1-9]\d{0,19}$/.test(sequence)) continue;
    const value = BigInt(sequence);
    if (value > latest && value <= 0xffffffffffffffffn) latest = value;
  }
  return latest > 0n ? latest.toString() : undefined;
}

/** 同一个人的多次申请只把最新一张待处理卡片绑定到当前在线请求。 */
export function bindNoticeOperations<T extends ContactRequest | GroupJoinRequest>(
  notices: T[],
  operations: NoticeOperation[],
): { cards: Array<{ notice: T; operation?: NoticeOperation }>; remaining: NoticeOperation[] } {
  const unique = new Map<string, NoticeOperation>();
  for (const operation of operations) {
    const key = operation.noticeId ?? `${operation.kind}:${operation.token}`;
    if (!unique.has(key) || operation.kind === 'doubtFriend') unique.set(key, operation);
  }
  const remaining = new Set(unique.values());
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
        return (
          sameUser &&
          n.direction === 'incoming' &&
          n.status === 'pending' &&
          !op.groupId &&
          (!op.noticeId?.startsWith('buddy-request:') || op.noticeId === n.id)
        );
      return (
        n.action === '申请加入' &&
        n.handleState === 'pending' &&
        op.groupId === n.group.id &&
        Boolean(n.isDoubt) === (op.kind === 'filteredGroup') &&
        (n.sequence && op.sequence ? n.sequence === op.sequence : sameUser)
      );
    });
    if (candidate) {
      card.operation = candidate;
      remaining.delete(candidate);
    }
  }
  return { cards, remaining: [...remaining] };
}

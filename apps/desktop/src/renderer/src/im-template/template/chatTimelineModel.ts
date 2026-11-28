import { calendarParts, timeDate } from '@weq/time';
import type { Message, UnreadDock } from './types';
import { grayTipOf } from './messageRow.shared';
import { shouldShowMessageTime } from './messageTime.shared';

export function countAppendedMessages(lastId: string | null, messages: Message[], selfId: string) {
  const index = lastId
    ? messages.findIndex(({ id, outgoingId }) => (outgoingId ?? id) === lastId)
    : -1;
  let count = 0;
  for (let i = index < 0 ? Math.max(0, messages.length - 1) : index + 1; i < messages.length; i++)
    if (messages[i]!.senderId !== selfId) count++;
  return count;
}

export function unreadTimelineStart(
  dock: UnreadDock | null | undefined,
  unreadCount?: number,
  confirmedReadSeq?: string,
) {
  if (unreadCount === 0) return undefined;
  if (unreadCount && confirmedReadSeq && /^[1-9]\d{0,19}$/.test(confirmedReadSeq))
    return String(BigInt(confirmedReadSeq) + 1n);
  return dock?.firstUnreadSeq ?? dock?.stops.find(({ kind }) => kind === 'unread')?.seq;
}

/** 缺号时只在已加载范围跨过起点的情况下，标记区间内最早的真实消息。 */
export function unreadTimelineBoundary(
  messages: readonly Message[],
  firstSeq: string,
  lastSeq?: string,
) {
  if (!/^[1-9]\d{0,19}$/.test(firstSeq)) return undefined;
  const first = BigInt(firstSeq);
  let last: bigint | undefined;
  if (lastSeq !== undefined) {
    if (!/^[1-9]\d{0,19}$/.test(lastSeq)) return undefined;
    last = BigInt(lastSeq);
    if (first > last) return undefined;
  }
  let earlier = false;
  let next: { id: string; seq: bigint } | undefined;
  for (const message of messages) {
    if (
      !message.msgSeq ||
      !/^[1-9]\d{0,19}$/.test(message.msgSeq) ||
      message.optimistic ||
      (message.source && !message.ntSeqVerified) ||
      grayTipOf(message)
    )
      continue;
    const seq = BigInt(message.msgSeq);
    if (seq === first) return message.id;
    if (seq < first) earlier = true;
    else if ((last === undefined || seq <= last) && (!next || seq < next.seq))
      next = { id: message.id, seq };
  }
  return earlier ? next?.id : undefined;
}

export type MessageGroupPosition = 'first' | 'middle' | 'last';

export function messageTimelineSpacing(position: MessageGroupPosition | undefined, last: boolean) {
  if (last) return 0;
  return position === 'first' || position === 'middle' ? 4 : 18;
}

type MessageGroupKey = {
  senderId?: string;
  senderUid?: string;
  senderSnapshotId?: string;
  time: number;
  provisionalTime?: boolean;
};

export function consecutiveMessageGroups<T>(
  messages: readonly T[],
  keyFor: (message: T) => MessageGroupKey | undefined,
  breakBefore: (previous: T, message: T) => boolean,
): Array<MessageGroupPosition | undefined> {
  const result: Array<MessageGroupPosition | undefined> = new Array(messages.length);
  let previous: MessageGroupKey | undefined;
  let previousDay: number | undefined;
  for (const [index, message] of messages.entries()) {
    const key = keyFor(message);
    const day = calendarParts(key?.time)?.dayIndex;
    if (previous && key && day !== undefined && day === previousDay) {
      const sameId = !!key.senderId && key.senderId === previous.senderId;
      const sameUid = !!key.senderUid && key.senderUid === previous.senderUid;
      if (
        (sameId || sameUid) &&
        (!key.senderId || !previous.senderId || sameId) &&
        (!key.senderUid || !previous.senderUid || sameUid) &&
        (!key.senderSnapshotId ||
          !previous.senderSnapshotId ||
          key.senderSnapshotId === previous.senderSnapshotId) &&
        // 排队占位用本地提交时间，逐条换成 QQ 时间时，相邻两条可能短暂倒序。
        (key.time >= previous.time || key.provisionalTime || previous.provisionalTime) &&
        !shouldShowMessageTime(
          Math.min(previous.time, key.time),
          Math.max(previous.time, key.time),
        ) &&
        !breakBefore(messages[index - 1]!, message)
      ) {
        result[index - 1] = result[index - 1] === 'last' ? 'middle' : 'first';
        result[index] = 'last';
        // 保留组内已核对的身份，个别行缺少 QQ 号或 UID 时不会丢掉另一项。
        previous = {
          ...key,
          senderId: key.senderId || previous.senderId,
          senderUid: key.senderUid || previous.senderUid,
          senderSnapshotId: key.senderSnapshotId || previous.senderSnapshotId,
        };
        continue;
      }
    }
    previous = key;
    previousDay = day;
  }
  return result;
}

export function messageGroups(
  messages: readonly Message[],
  {
    standalone,
    breakBefore,
  }: {
    standalone: (message: Message) => boolean;
    breakBefore: (previous: Message, message: Message) => boolean;
  },
): Array<MessageGroupPosition | undefined> {
  return consecutiveMessageGroups(
    messages,
    (message) => {
      if (
        !message.senderId ||
        message.senderId === '0' ||
        message.deletedKind ||
        grayTipOf(message) ||
        standalone(message)
      )
        return;
      const time = timeDate(message.createdAt)?.getTime();
      if (time !== undefined) {
        return {
          senderId: message.senderId,
          senderUid: message.senderUid,
          time,
          provisionalTime: Boolean(message.optimistic),
        };
      }
    },
    (previous, message) =>
      previous.historicalSenderName !== message.historicalSenderName ||
      breakBefore(previous, message),
  );
}

/** Rebuild the visible group heads after the user omits rows from a chat image. */
export function selectedMessageLayout(
  selection: readonly Message[],
  timeline: readonly Message[],
  {
    group,
    standalone,
    breakBefore,
  }: {
    group: boolean;
    standalone: (message: Message) => boolean;
    breakBefore: (message: Message) => boolean;
  },
) {
  const positions = new Map(timeline.map(({ id }, index) => [id, index]));
  const separated = (previous: Message, message: Message) => {
    const position = positions.get(previous.id);
    return position === undefined || positions.get(message.id) !== position + 1;
  };
  const groups = group
    ? messageGroups(selection, {
        standalone,
        breakBefore: (previous, message) => separated(previous, message) || breakBefore(message),
      })
    : undefined;
  return selection.map((message, index) => {
    const previous = selection[index - 1];
    return {
      groupPosition: groups?.[index],
      showTime:
        !previous ||
        separated(previous, message) ||
        shouldShowMessageTime(previous.createdAt, message.createdAt),
    };
  });
}

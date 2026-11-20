import { calendarParts, timeDate } from '@weq/time';
import type { Message } from './types';
import { grayTipOf } from './messageRow.shared';
import { shouldShowMessageTime } from './messageTime.shared';
import { messageGapCount } from './messageGap.shared';

export type UnreadJumpState = {
  conversationId: string;
  remaining: number;
  startScrollTop?: number;
  targetScrollTop?: number;
  total: number;
};

export type UnreadJumpSeed = {
  conversationId: string;
  total: number;
};

export function countAppendedMessages(lastId: string | null, messages: Message[], selfId: string) {
  const index = lastId ? messages.findIndex((message) => message.id === lastId) : -1;
  let count = 0;
  for (let i = index < 0 ? Math.max(0, messages.length - 1) : index + 1; i < messages.length; i++)
    if (messages[i]!.senderId !== selfId) count++;
  return count;
}

export type MessageGroupPosition = 'first' | 'middle' | 'last';

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
  const result: Array<MessageGroupPosition | undefined> = new Array(messages.length);
  let previous: Message | undefined;
  let previousTime = 0;
  let previousDay: number | undefined;
  for (const [index, message] of messages.entries()) {
    if (
      !message.senderId ||
      message.senderId === '0' ||
      message.deletedKind ||
      message.recall ||
      message.optimistic ||
      grayTipOf(message) ||
      message.qqElements?.some(({ type }) => type === 'reply') ||
      standalone(message)
    ) {
      previous = undefined;
      continue;
    }
    const time = timeDate(message.createdAt)?.getTime();
    const day = calendarParts(time)?.dayIndex;
    if (
      previous?.senderId === message.senderId &&
      (!previous.senderUid || !message.senderUid || previous.senderUid === message.senderUid) &&
      time !== undefined &&
      time >= previousTime &&
      day === previousDay &&
      !shouldShowMessageTime(previousTime, time) &&
      !messageGapCount(previous, message, true) &&
      !breakBefore(previous, message)
    ) {
      result[index - 1] = result[index - 1] === 'last' ? 'middle' : 'first';
      result[index] = 'last';
    }
    previous = time === undefined ? undefined : message;
    previousTime = time ?? 0;
    previousDay = day;
  }
  return result;
}

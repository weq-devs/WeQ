import type { Message } from './types';

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

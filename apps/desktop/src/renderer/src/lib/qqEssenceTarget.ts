import type { Conversation, Message } from '../im-template/template/types';

export function qqEssenceTarget(
  conversation: Conversation,
  message: Message,
): { groupId: number; sequence: number; random: number } | null {
  if (
    conversation.type !== 'group' ||
    message.conversationId !== conversation.id ||
    message.optimistic === 'sending' ||
    message.optimistic === 'failed' ||
    message.optimisticRejected
  )
    return null;
  const parts = [conversation.id, message.msgSeq, message.msgRandom];
  if (parts.some((value) => !value || !/^\d+$/.test(value))) return null;
  const groupId = Number(conversation.id);
  const sequence = Number(message.msgSeq);
  const random = Number(message.msgRandom);
  if (
    !Number.isSafeInteger(groupId) ||
    groupId <= 0 ||
    groupId > 0xffffffff ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0 ||
    sequence > 0xffffffff ||
    !Number.isSafeInteger(random) ||
    random < 0 ||
    random > 0xffffffff
  )
    return null;
  return { groupId, sequence, random };
}

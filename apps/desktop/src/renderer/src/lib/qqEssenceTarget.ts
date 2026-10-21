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
  return qqEssenceTargetParts(conversation.id, message.msgSeq, message.msgRandom);
}

export function qqEssenceTargetParts(
  group: string,
  seq?: string,
  rand?: string,
): { groupId: number; sequence: number; random: number } | null {
  const parts = [group, seq, rand];
  if (parts.some((value) => !value || !/^\d+$/.test(value))) return null;
  const groupId = Number(group);
  const sequence = Number(seq);
  const random = Number(rand);
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

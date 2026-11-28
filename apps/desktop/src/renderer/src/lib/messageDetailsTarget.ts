import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import type { Conversation, Message } from '../im-template/template/types';
import type { client } from '../trpc/client';
import { readonlyConversationKind } from './conversationActions';
import { isLocalOutgoingMessage } from './messageSelection';

type MessageDetailsTarget = Parameters<typeof client.account.messageRecordDetails.query>[0];

export function messageDetailsTarget(
  binding: QQWriteBinding | null | undefined,
  conversation: Conversation | null | undefined,
  message: Message,
): MessageDetailsTarget | undefined {
  const msgId = message.msgId ?? message.id;
  const source = readonlyConversationKind(conversation);
  if (
    !binding ||
    !conversation ||
    conversation.generated ||
    conversation.id.startsWith('virtual:') ||
    source === 'guild' ||
    message.forwardSnapshot ||
    isLocalOutgoingMessage(message) ||
    !/^-?\d{1,20}$/.test(msgId)
  )
    return undefined;

  if (conversation.type === 'direct' && conversation.directoryKind === 'aiAssistant') {
    const sessionId = conversation.aiAssistantSessionId;
    return sessionId ? { ...binding, kind: 'aiAssistant', conv: sessionId, msgId } : undefined;
  }
  const kind = source ?? (conversation.type === 'group' ? 'group' : 'c2c');
  const conv =
    conversation.type === 'group'
      ? conversation.group.identityValue
      : conversation.type === 'direct'
        ? kind === 'service'
          ? conversation.id.replace(/^service:/, '')
          : conversation.otherUser.id
        : null;
  if (!conv) return undefined;
  const target: MessageDetailsTarget = { ...binding, kind, conv, msgId };
  if (message.source !== 'roaming' && !message.recall?.retained) return target;
  if (kind !== 'c2c' && kind !== 'group') return undefined;

  return {
    ...target,
    cache: {
      format: message.sourceFormat,
      retained: Boolean(message.recall?.retained),
      seq: message.msgSeq && /^-?\d{1,20}$/.test(message.msgSeq) ? message.msgSeq : undefined,
    },
  };
}

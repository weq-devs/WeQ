import type { RoamingTarget } from '@weq/service';
import type { ContentSelection } from '../../../shared/content_selection';
import type { Conversation } from '../im-template/template/types';
import type { AnalysisTarget } from '../views/analysis/model';
import { generatedContentContainer } from '../../../shared/content_selection';
import { classifyChatType } from '@weq/codec';

export function conversationSourceLabel(conversation?: Conversation): string | undefined {
  if (!conversation) return undefined;
  if (conversation.generated)
    return conversation.generated.kind === 'assistant' ? '助手会话' : '克隆会话';
  const kind = readonlyConversationKind(conversation);
  if (kind === 'guild') return '频道私聊';
  if (kind === 'official') return '公众号会话';
  if (kind === 'service' || conversation.id.startsWith('service:')) return '服务号会话';
  return undefined;
}

export function readonlyConversationKind(
  conversation?: Conversation | null,
): 'guild' | 'official' | 'service' | undefined {
  if (!conversation || conversation.generated) return undefined;
  if (conversation.directoryKind === 'guild' || conversation.id.startsWith('guild:'))
    return 'guild';
  const chatKind =
    conversation.type === 'direct' && conversation.chatType !== undefined
      ? classifyChatType(conversation.chatType)
      : undefined;
  if (
    conversation.directoryKind === 'service' ||
    conversation.id.startsWith('service:') ||
    chatKind === 'service'
  )
    return 'service';
  if (conversation.directoryKind === 'official' || chatKind === 'official') return 'official';
  return undefined;
}

export function ordinaryQqConversation(conversation: Conversation): boolean {
  if (conversation.directoryKind && conversation.directoryKind !== 'qq') return false;
  if (conversation.id.startsWith('guild:') || conversation.id.startsWith('service:')) return false;
  if (conversation.type === 'direct' && conversation.chatType !== undefined) {
    const kind = classifyChatType(conversation.chatType);
    if (kind === 'official' || kind === 'service' || kind === 'dataline') return false;
  }
  return true;
}

export function conversationExportSelection(
  conversation?: Conversation | null,
): ContentSelection | null {
  if (conversation?.generated) {
    if (conversation.generated.kind === 'assistant' && !conversation.generated.sessionId)
      return null;
    return {
      owner: {
        kind: conversation.generated.kind === 'assistant' ? 'assistant-messages' : 'clone-messages',
        container: generatedContentContainer(conversation.generated),
      },
      scope: { type: 'all' },
    };
  }
  const sourceKind = readonlyConversationKind(conversation);
  if (conversation && sourceKind === 'guild')
    return {
      owner: { kind: 'guild-direct', container: conversation.id.replace(/^guild:/, '') },
      scope: { type: 'all' },
    };
  if (conversation?.type === 'direct' && (sourceKind === 'official' || sourceKind === 'service'))
    return {
      owner: {
        kind: 'messages',
        container: `direct:${conversation.id}`,
        conversationTarget: {
          id: conversation.id,
          name: conversation.otherUser.displayName,
          kind: sourceKind,
          ownerId:
            sourceKind === 'service'
              ? conversation.id.replace(/^service:/, '')
              : conversation.otherUser.id,
        },
      },
      scope: { type: 'all' },
    };
  if (
    !conversation ||
    conversation.id.startsWith('virtual:') ||
    (conversation.type !== 'direct' && conversation.type !== 'group')
  )
    return null;
  return {
    owner: { kind: 'messages', container: `${conversation.type}:${conversation.id}` },
    scope: { type: 'all' },
  };
}

export function conversationAnalysisTarget(
  conversation?: Conversation | null,
): AnalysisTarget | null {
  if (
    !conversation ||
    conversation.generated ||
    conversation.id.startsWith('virtual:') ||
    !ordinaryQqConversation(conversation)
  )
    return null;
  if (conversation.type === 'group') return { kind: 'group', groupCode: conversation.group.id };
  if (conversation.type === 'direct' && conversation.otherUser.id.startsWith('u_'))
    return { kind: 'buddy', peerUid: conversation.otherUser.id };
  return null;
}

export function conversationRoamingTarget(
  conversation?: Conversation | null,
): RoamingTarget | null {
  if (
    !conversation ||
    conversation.generated ||
    conversation.id.startsWith('virtual:') ||
    !ordinaryQqConversation(conversation)
  )
    return null;
  if (
    conversation.type === 'group' &&
    /^[1-9]\d*$/.test(conversation.group.id) &&
    Number.isSafeInteger(Number(conversation.group.id))
  )
    return {
      kind: 'group',
      conv: conversation.group.id,
      name: conversation.group.name || conversation.group.id,
    };
  if (conversation.type === 'direct' && /^u_[A-Za-z0-9_-]{1,125}$/.test(conversation.otherUser.id))
    return {
      kind: 'c2c',
      conv: conversation.otherUser.id,
      name:
        conversation.otherUser.displayName ||
        conversation.otherUser.identityValue ||
        conversation.otherUser.id,
    };
  return null;
}

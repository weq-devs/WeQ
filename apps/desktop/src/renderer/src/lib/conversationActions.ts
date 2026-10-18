import type { RoamingTarget } from '@weq/service';
import type { ContentSelection } from '../../../shared/content_selection';
import type { Conversation } from '../im-template/template/types';
import type { AnalysisTarget } from '../views/analysis/model';

export function conversationExportSelection(
  conversation?: Conversation | null,
): ContentSelection | null {
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
  if (!conversation || conversation.id.startsWith('virtual:')) return null;
  if (conversation.type === 'group') return { kind: 'group', groupCode: conversation.group.id };
  if (conversation.type === 'direct' && conversation.otherUser.id.startsWith('u_'))
    return { kind: 'buddy', peerUid: conversation.otherUser.id };
  return null;
}

export function conversationRoamingTarget(
  conversation?: Conversation | null,
): RoamingTarget | null {
  if (!conversation || conversation.id.startsWith('virtual:')) return null;
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

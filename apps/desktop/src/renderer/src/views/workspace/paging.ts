import { isDataline } from '../../lib/deviceAvatar';
import type { FirstPageTarget } from '../../lib/conversationFirstPage';
import type { Conversation } from '../../im-template/template';

export const PAGE_SIZE = 50;

export const GROUP_INITIAL_PAGE_SIZE = 25;

export function prefetchTarget(conversation: Conversation): FirstPageTarget | undefined {
  if (conversation.id.startsWith('virtual:') || conversation.id.startsWith('guild:'))
    return undefined;
  if (conversation.type === 'group')
    return { kind: 'group', conv: conversation.id, limit: GROUP_INITIAL_PAGE_SIZE };
  if (
    conversation.type === 'direct' &&
    conversation.id.startsWith('u_') &&
    !isDataline(conversation.chatType ?? 1)
  )
    return { kind: 'c2c', conv: conversation.id, limit: PAGE_SIZE };
  return undefined;
}

export const GROUP_MEMBER_PAGE_SIZE = 120;

/**
 * 后台刷新只重读有界尾页；已加载但不在这次查询范围内的历史保留原位。
 */
export const REFRESH_CAP = 500;

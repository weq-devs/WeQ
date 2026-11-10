import type { Conversation } from '../im-template/template/types';
import { displayGroupName, displayUserName } from '../im-template/template/user';

/** 列表与日历共用同一名称/号码匹配串，聚合入口不隐式变成子会话全文搜索。 */
export function conversationListSearchText(conversation: Conversation): string {
  const title =
    conversation.type === 'merged'
      ? conversation.title
      : conversation.type === 'group'
        ? displayGroupName(conversation.group)
        : displayUserName(conversation.otherUser);
  const seed =
    conversation.type === 'direct' ? conversation.otherUser.identityValue : conversation.id;
  return `${title} ${seed} ${conversation.type === 'group' ? conversation.group.name : ''}`.toLocaleLowerCase();
}

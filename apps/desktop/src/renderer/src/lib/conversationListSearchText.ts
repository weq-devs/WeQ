import type { Conversation } from '../im-template/template/types';
import { displayGroupName, displayUserName } from '../im-template/template/user';
import { createPinyinMatcher } from '@weq/codec/pinyin-search';

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

export function createConversationListMatcher(query: string) {
  const needle = query.trim().toLocaleLowerCase();
  const pinyin = createPinyinMatcher(needle);
  return (conversation: Conversation): boolean => {
    if (!needle || conversationListSearchText(conversation).includes(needle)) return true;
    if (!pinyin) return false;
    if (conversation.type === 'group')
      return pinyin.test(conversation.group.remark, conversation.group.name);
    if (conversation.type === 'direct')
      return pinyin.test(conversation.otherUser.displayName, conversation.otherUser.username);
    return pinyin.test(conversation.title);
  };
}

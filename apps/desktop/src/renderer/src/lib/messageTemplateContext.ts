import type { Conversation } from '../im-template/template/types';

/** 列表未读、排序或预览变化不影响消息发送者；对端资料变化仍须重新映射。 */
export function messageTemplateContext(conversation: Conversation | undefined): string {
  if (!conversation) return '';
  return JSON.stringify(
    conversation.type === 'direct'
      ? [conversation.id, conversation.type, conversation.chatType, conversation.otherUser]
      : [conversation.id, conversation.type],
  );
}

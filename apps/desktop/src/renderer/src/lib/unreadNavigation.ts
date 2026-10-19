import type { Conversation, ConversationPreferences } from '../im-template/template/types';

/** 与会话列表一致：置顶优先、组内保留原顺序，免打扰不属于红点目标。 */
export function firstUnreadConversation(
  conversations: readonly Conversation[],
  preferences: ConversationPreferences,
): Conversation | null {
  const preference = (row: Conversation) => ({ ...row.preference, ...preferences[row.id] });
  const unread = conversations.filter(
    (row) => (row.unreadCount ?? 0) > 0 && !preference(row).muted,
  );
  return unread.find((row) => preference(row).pinned) ?? unread[0] ?? null;
}

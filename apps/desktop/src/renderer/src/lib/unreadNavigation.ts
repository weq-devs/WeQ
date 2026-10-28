import type { Conversation, ConversationPreferences } from '../im-template/template/types';

/** 与会话列表一致：置顶优先；普通未读优先，免打扰作为后备目标。 */
export function firstUnreadConversation(
  conversations: readonly Conversation[],
  preferences: ConversationPreferences,
  showGroupAssistantMessageCount = false,
): Conversation | null {
  const preference = (row: Conversation) => ({ ...row.preference, ...preferences[row.id] });
  const unread = conversations.filter(
    (row) =>
      (row.unreadCount ?? 0) > 0 &&
      (row.type !== 'merged' ||
        row.mergedKind !== 'groupAssistant' ||
        showGroupAssistantMessageCount),
  );
  const normal = unread.filter((row) => !preference(row).muted);
  const targets = normal.length ? normal : unread;
  return targets.find((row) => preference(row).pinned) ?? targets[0] ?? null;
}

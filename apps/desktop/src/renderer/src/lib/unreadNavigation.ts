import type { Conversation, ConversationPreferences } from '../im-template/template/types';

/** 在未读区间内选最早的真实消息，不回退到已读水位之前。 */
export function firstUnreadMessage<T extends { msgSeq: string }>(
  messages: readonly T[],
  firstUnreadSeq: string,
): T | undefined {
  const start = BigInt(firstUnreadSeq);
  let first: T | undefined;
  let firstSeq: bigint | undefined;
  for (const message of messages) {
    if (!/^\d+$/.test(message.msgSeq)) continue;
    const seq = BigInt(message.msgSeq);
    if (seq >= start && (firstSeq === undefined || seq < firstSeq)) {
      first = message;
      firstSeq = seq;
    }
  }
  return first;
}

/** 与会话列表一致：置顶优先；普通未读优先，免打扰作为后备目标。 */
export function firstUnreadConversation(
  conversations: readonly Conversation[],
  preferences: ConversationPreferences,
): Conversation | null {
  const preference = (row: Conversation) => ({ ...row.preference, ...preferences[row.id] });
  const unread = conversations.filter((row) => (row.unreadCount ?? 0) > 0);
  const normal = unread.filter((row) => !preference(row).muted);
  const targets = normal.length ? normal : unread;
  return targets.find((row) => preference(row).pinned) ?? targets[0] ?? null;
}

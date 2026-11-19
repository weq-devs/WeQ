import type {
  Conversation,
  ConversationPreferences,
  MergedKind,
} from '../im-template/template/types';
import { sortConversationRows } from './conversationListOrder';
import { aggregateView, type ConversationViewDirectory } from './conversationViews';

type AggregateUnreadBadges = Readonly<Partial<Record<MergedKind, boolean>>>;

function isMuted(row: Conversation, preferences: ConversationPreferences): boolean {
  return Boolean(
    row.generated ? row.preference?.muted : (preferences[row.id]?.muted ?? row.preference?.muted),
  );
}

/** 导航角标统计常规视图的未读来源；聚合入口只加其未免打扰的成员，不重复加汇总行。 */
export function countMessageNavigationUnread(
  directory: ConversationViewDirectory,
  preferences: ConversationPreferences,
  aggregateBadges: AggregateUnreadBadges,
): number {
  let total = 0;
  const counted = new Set<string>();
  const add = (row: Conversation) => {
    if (!row.unreadCount || isMuted(row, preferences) || counted.has(row.id)) return;
    counted.add(row.id);
    total += row.unreadCount;
  };
  for (const row of directory.regular) {
    if (row.type !== 'merged') add(row);
    else if (row.unreadCount && aggregateBadges[row.mergedKind] && !isMuted(row, preferences)) {
      for (const member of directory[aggregateView(row.mergedKind)]) add(member);
    }
  }
  return total;
}

export type UnreadMessageIdentity = { senderUid?: string; sendTime?: string };

export function matchesUnreadMessage(
  message: UnreadMessageIdentity & { msgSeq?: string },
  seq: string,
  identity?: UnreadMessageIdentity,
): boolean {
  return (
    message.msgSeq === seq &&
    (!identity?.senderUid || message.senderUid === identity.senderUid) &&
    (!identity?.sendTime || message.sendTime === identity.sendTime)
  );
}

/** 在未读区间内选最早的真实消息，不回退到已读水位之前。 */
export function firstUnreadMessage<T extends { msgSeq?: string }>(
  messages: readonly T[],
  firstUnreadSeq: string,
): T | undefined {
  const start = BigInt(firstUnreadSeq);
  let first: T | undefined;
  let firstSeq: bigint | undefined;
  for (const message of messages) {
    if (!message.msgSeq || !/^\d+$/.test(message.msgSeq)) continue;
    const seq = BigInt(message.msgSeq);
    if (seq >= start && (firstSeq === undefined || seq < firstSeq)) {
      first = message;
      firstSeq = seq;
    }
  }
  return first;
}

/** 每轮按当前优先级遍历未读会话；已经定位过的行重排或消失，不会打断这一轮。 */
export function createUnreadConversationCycle() {
  const visited = new Set<string>();
  return {
    reset: () => visited.clear(),
    next(
      conversations: readonly Conversation[],
      preferences: ConversationPreferences,
      aggregateBadges: AggregateUnreadBadges,
    ): Conversation | undefined {
      const unread = sortConversationRows(
        conversations.filter((row) => (row.unreadCount ?? 0) > 0),
        preferences,
      );
      const regular: Conversation[] = [];
      const muted: Conversation[] = [];
      const hiddenBadge: Conversation[] = [];
      for (const row of unread) {
        if (row.type === 'merged' && !aggregateBadges[row.mergedKind]) hiddenBadge.push(row);
        else if (isMuted(row, preferences)) muted.push(row);
        else regular.push(row);
      }
      const ordered = [...regular, ...muted, ...hiddenBadge];
      let target = ordered.find((row) => !visited.has(row.id));
      if (!target) {
        visited.clear();
        target = ordered[0];
      }
      if (target) visited.add(target.id);
      return target;
    },
  };
}

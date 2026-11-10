import {
  conversationActivityTime,
  conversationPinned,
  pinOrderDelta,
} from '@weq/service/conversation-order';
import { replaceEqualDeep } from '@tanstack/react-query';

/** 排序与单个角标变化不改变其他会话引用，避免刷新当前聊天的整棵消息树。 */
export function reconcileConversationRows<T extends { id: string }>(previous: T[], next: T[]): T[] {
  const byId = new Map(previous.map((row) => [row.id, row]));
  const shared = next.map((row) => replaceEqualDeep(byId.get(row.id), row));
  return shared.length === previous.length && shared.every((row, index) => row === previous[index])
    ? previous
    : shared;
}

type OrderableConversation = Parameters<typeof conversationActivityTime>[0] &
  Parameters<typeof conversationPinned>[0];

/** 只在本轮排序内缓存键，既减少时间解析，也保留源对象后续修改的可见性。 */
export function sortConversationRows<T extends OrderableConversation>(
  rows: readonly T[],
  preferences: Parameters<typeof conversationPinned>[1] = {},
): T[] {
  return rows
    .map((row) => ({
      row,
      pinned: conversationPinned(row, preferences),
      time: conversationActivityTime(row),
    }))
    .sort(
      (first, second) =>
        pinOrderDelta(first.pinned, second.pinned) ||
        second.time - first.time ||
        first.row.id.localeCompare(second.row.id),
    )
    .map(({ row }) => row);
}

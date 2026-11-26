import {
  conversationActivityTime,
  conversationPinned,
  pinOrderDelta,
} from '@weq/service/conversation-order';
import { replaceEqualDeep } from '@tanstack/react-query';

/** 排序与单个角标变化不改变其他会话引用，避免刷新当前聊天的整棵消息树。 */
export function reconcileConversationRows<T extends { id: string }>(previous: T[], next: T[]): T[] {
  if (previous.length === next.length && next.every((row, index) => row === previous[index]))
    return previous;
  const byId = new Map(previous.map((row) => [row.id, row]));
  const shared = next.map((row) => replaceEqualDeep(byId.get(row.id), row));
  return shared.length === previous.length && shared.every((row, index) => row === previous[index])
    ? previous
    : shared;
}

type OrderableConversation = Parameters<typeof conversationActivityTime>[0] &
  Parameters<typeof conversationPinned>[0];
type PinPreferences = Parameters<typeof conversationPinned>[1];
type OrderEntry<T> = {
  row: T;
  pinned: boolean;
  updatedAt: string;
  lastMessageAt: string | undefined;
  activityTime: number | undefined;
  time: number;
};
export type ConversationOrder<T> = { rows: T[]; entries: OrderEntry<T>[] };

function compareOrder<T extends { id: string }>(first: OrderEntry<T>, second: OrderEntry<T>) {
  return (
    pinOrderDelta(first.pinned, second.pinned) ||
    second.time - first.time ||
    first.row.id.localeCompare(second.row.id)
  );
}

/** 延用未移动行的次序。只重排本轮改变置顶或活动时间的行。 */
export function updateConversationOrder<T extends OrderableConversation>(
  rows: readonly T[],
  previous?: ConversationOrder<T>,
  preferences?: PinPreferences,
): ConversationOrder<T> {
  const pending = new Map(rows.map((row) => [row.id, row]));
  const entry = (row: T, before?: OrderEntry<T>): OrderEntry<T> => {
    const pinned = conversationPinned(row, preferences);
    const { updatedAt, activityTime } = row;
    const lastMessageAt = row.lastMessage?.createdAt;
    if (
      before &&
      before.updatedAt === updatedAt &&
      before.lastMessageAt === lastMessageAt &&
      before.activityTime === activityTime
    )
      return before.row === row && before.pinned === pinned ? before : { ...before, row, pinned };
    return {
      row,
      pinned,
      updatedAt,
      lastMessageAt,
      activityTime,
      time: conversationActivityTime({ updatedAt, lastMessage: row.lastMessage, activityTime }),
    };
  };
  if (pending.size !== rows.length) {
    const entries = rows.map((row) => entry(row)).sort(compareOrder);
    return { entries, rows: entries.map(({ row }) => row) };
  }
  const kept: OrderEntry<T>[] = [];
  const moved: OrderEntry<T>[] = [];
  for (const before of previous?.entries ?? []) {
    const row = pending.get(before.row.id);
    if (!row) continue;
    pending.delete(row.id);
    const next = entry(row, before);
    if (next.pinned === before.pinned && next.time === before.time) kept.push(next);
    else moved.push(next);
  }
  for (const row of pending.values()) moved.push(entry(row));
  moved.sort(compareOrder);
  const entries: OrderEntry<T>[] = [];
  let index = 0;
  for (const next of moved) {
    while (index < kept.length && compareOrder(kept[index]!, next) <= 0)
      entries.push(kept[index++]!);
    entries.push(next);
  }
  for (; index < kept.length; index++) entries.push(kept[index]!);
  if (
    previous &&
    entries.length === previous.entries.length &&
    entries.every((item, index) => item === previous.entries[index])
  )
    return previous;
  return { entries, rows: entries.map(({ row }) => row) };
}

/** 只在本轮排序内缓存键，既减少时间解析，也保留源对象后续修改的可见性。 */
export function sortConversationRows<T extends OrderableConversation>(
  rows: readonly T[],
  preferences: Parameters<typeof conversationPinned>[1] = {},
  activityTime: (row: T) => number = conversationActivityTime,
): T[] {
  return rows
    .map((row) => ({
      row,
      pinned: conversationPinned(row, preferences),
      time: activityTime(row),
    }))
    .sort(
      (first, second) =>
        pinOrderDelta(first.pinned, second.pinned) ||
        second.time - first.time ||
        first.row.id.localeCompare(second.row.id),
    )
    .map(({ row }) => row);
}

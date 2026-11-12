import { useLayoutEffect, useRef } from 'react';

/** 仅保持身份顺序，正文、未读和资料始终使用最新对象；新会话暂时追加。 */
export function useConversationHoverOrder<T extends { id: string }>(
  rows: T[],
  freeze: boolean,
  resetKey: string,
): T[] {
  const committed = useRef({ key: resetKey, ids: rows.map((row) => row.id) });
  let ordered = rows;
  if (freeze && committed.current.key === resetKey) {
    const remaining = new Map(rows.map((row) => [row.id, row]));
    ordered = [];
    for (const id of committed.current.ids) {
      const row = remaining.get(id);
      if (row) ordered.push(row);
      remaining.delete(id);
    }
    ordered.push(...remaining.values());
  }
  useLayoutEffect(() => {
    committed.current = { key: resetKey, ids: ordered.map((row) => row.id) };
  });
  return ordered;
}

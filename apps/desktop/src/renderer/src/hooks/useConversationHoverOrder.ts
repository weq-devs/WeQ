import { useLayoutEffect, useMemo, useRef } from 'react';

/** 仅保持身份顺序，正文、未读和资料始终使用最新对象；新会话暂时追加。 */
export function useConversationHoverOrder<T extends { id: string }>(
  rows: T[],
  freeze: boolean,
  resetKey: string,
): T[] {
  const committed = useRef<{ key: string; ids: string[] } | null>(null);
  const ordered = useMemo(() => {
    if (!freeze || committed.current?.key !== resetKey) return rows;
    const remaining = new Map(rows.map((row) => [row.id, row]));
    const frozen: T[] = [];
    for (const id of committed.current.ids) {
      const row = remaining.get(id);
      if (row) frozen.push(row);
      remaining.delete(id);
    }
    frozen.push(...remaining.values());
    return frozen;
  }, [rows, freeze, resetKey]);
  useLayoutEffect(() => {
    committed.current = { key: resetKey, ids: ordered.map((row) => row.id) };
  }, [ordered, resetKey]);
  return ordered;
}

import { replaceEqualDeep } from '@tanstack/react-query';

/** 完整 wire 按 UID 替换；等值保留原引用，只在首个有效变化时复制索引。 */
export function reconcileResolvedRows<T extends { uid: string }>(
  previous: Record<string, T>,
  incoming: readonly T[],
  accept?: (row: T) => boolean,
): Record<string, T> {
  let next = previous;
  for (const row of incoming) {
    if (accept && !accept(row)) continue;
    const current = Object.hasOwn(next, row.uid) ? next[row.uid] : undefined;
    const shared = replaceEqualDeep(current, row);
    if (shared === current) continue;
    if (next === previous) next = { ...previous };
    Object.defineProperty(next, row.uid, {
      value: shared,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return next;
}

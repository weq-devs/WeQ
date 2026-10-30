export interface HistoryCursor {
  msgSeq: bigint;
  sendTime: bigint;
  msgId: bigint;
}

/** 缓存可有 uint64 ID；将比较边界等价改写到 SQLite 原生 int64 域。 */
export function nativeHistoryCursor(
  cursor: HistoryCursor | undefined,
  descending: boolean,
): HistoryCursor | undefined {
  if (!cursor) return undefined;
  const max = 0x7fffffffffffffffn;
  const min = -0x8000000000000000n;
  if (cursor.msgId > max)
    return descending
      ? { ...cursor, sendTime: cursor.sendTime + 1n, msgId: min }
      : { ...cursor, msgId: max };
  if (cursor.msgId < min)
    return descending
      ? { ...cursor, msgId: min }
      : { ...cursor, sendTime: cursor.sendTime - 1n, msgId: max };
  return cursor;
}

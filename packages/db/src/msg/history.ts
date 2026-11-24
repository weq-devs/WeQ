import type { SqlRow, SqlValue } from '@weq/native';
import type { QqDb } from '../qq_db';

export interface HistoryCursor {
  msgSeq: bigint;
  sendTime: bigint;
  msgId: bigint;
}

/** Keep the indexed positive-sequence path separate from imported rows without a sequence. */
export async function newestHistoryPage(
  db: QqDb,
  table: string,
  columns: string,
  partition: { clause: string; value: SqlValue },
  limit: number,
  before?: HistoryCursor,
): Promise<SqlRow[]> {
  const rows: SqlRow[] = [];
  const read = (scope: string, seq: string, cursor?: HistoryCursor) =>
    db.query(
      `SELECT ${columns} FROM ${table} WHERE ${partition.clause} AND (${scope})
       ${cursor ? `AND (${seq},COALESCE("40050",0),"40001") < (?,?,?)` : ''}
       ORDER BY ${seq} DESC, COALESCE("40050",0) DESC, "40001" DESC LIMIT ?`,
      [
        partition.value,
        ...(cursor ? [cursor.msgSeq, cursor.sendTime, cursor.msgId] : []),
        BigInt(limit - rows.length),
      ],
    );
  if (!before || before.msgSeq > 0n) {
    rows.push(...(await read('"40003">0', '"40003"', before)));
    if (rows.length >= limit) return rows;
  }
  rows.push(
    ...(await read(
      '"40003"<=0 OR "40003" IS NULL',
      'COALESCE("40003",0)',
      before && before.msgSeq <= 0n ? before : undefined,
    )),
  );
  return rows;
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

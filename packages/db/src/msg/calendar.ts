import type { SqlValue } from '@weq/native';
import type { QqDb } from '../qq_db';

export interface MessageDay {
  day: string;
  count: number;
}
export interface MessageBoundary {
  msgId: string;
  msgSeq: string;
  sendTime: number;
}
export interface MessageBounds {
  start?: number;
  end?: number;
}

export async function queryMessageDays(
  qq: QqDb,
  table: string,
  clause: string,
  value: SqlValue,
): Promise<MessageDay[]> {
  const rows = await qq.query(
    `SELECT date("40050",'unixepoch','+8 hours'),COUNT(*) FROM ${table}
    WHERE ${clause} AND "40050">0 AND "40050"<253402272000
    GROUP BY 1 ORDER BY 1`,
    [value],
  );
  return rows
    .filter((row) => typeof row[0] === 'string')
    .map((row) => ({ day: String(row[0]), count: Number(row[1]) }));
}

export async function queryMessageBoundary(
  qq: QqDb,
  table: string,
  clause: string,
  value: SqlValue,
  newest: boolean,
  bounds: MessageBounds = {},
): Promise<MessageBoundary | null> {
  const conditions = [clause, '"40003">0', '"40050">0', '"40050"<253402272000'];
  const params: SqlValue[] = [value];
  if (bounds.start !== undefined) {
    conditions.push('"40050">=?');
    params.push(BigInt(bounds.start));
  }
  if (bounds.end !== undefined) {
    conditions.push('"40050"<=?');
    params.push(BigInt(bounds.end));
  }
  const order = newest ? 'DESC' : 'ASC';
  const rows = await qq.query(
    `SELECT "40001","40003","40050" FROM ${table}
    WHERE ${conditions.join(' AND ')} ORDER BY "40050" ${order},"40003" ${order},"40001" ${order} LIMIT 1`,
    params,
  );
  return rows[0]
    ? { msgId: String(rows[0][0]), msgSeq: String(rows[0][1]), sendTime: Number(rows[0][2]) }
    : null;
}

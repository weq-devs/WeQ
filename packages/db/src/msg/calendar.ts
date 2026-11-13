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

/** 已有时间索引按年跳转；无时间索引时分段读取，不做整表 DISTINCT 排序。 */
export async function queryMessageYears(qq: QqDb, table: string): Promise<number[]> {
  const indexed = await qq.hasLeadingIndex(table, '40050');
  const years = new Set<number>();
  const end = 253402272000;
  const yearOf = (value: unknown) => {
    const time = Number(value);
    if (!(time > 0 && time < end)) return undefined;
    const year = new Date((time + 28800) * 1000).getUTCFullYear();
    return year > 0 && year <= 9999 ? year : undefined;
  };
  if (indexed) {
    let after = 0n;
    let first = true;
    for (;;) {
      const time = (
        await qq.query(
          `SELECT "40050" FROM ${table} WHERE "40050"${first ? '>' : '>='}? AND "40050"<? ORDER BY "40050" LIMIT 1`,
          [after, BigInt(end)],
        )
      )[0]?.[0];
      const year = yearOf(time);
      if (year === undefined) break;
      years.add(year);
      if (year === 9999) break;
      after = BigInt(Date.UTC(year + 1, 0, 1) / 1000 - 28800);
      first = false;
    }
  } else {
    for await (const rows of qq.rowidPages(table, ['40050'])) {
      for (const row of rows) {
        const year = yearOf(row[1]);
        if (year !== undefined) years.add(year);
      }
    }
  }
  return [...years].sort((a, b) => a - b);
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

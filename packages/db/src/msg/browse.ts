import type { SqlRow, SqlValue } from '@weq/native';
import type { QqDb } from '../qq_db';
import { toBigint } from './util';

export interface BrowseCursor {
  time: number | bigint;
  rowId: string;
}
export interface BrowseFilter {
  messageIds?: string[];
  start?: number;
  end?: number;
  sender?: string;
  senders?: string[];
  /** 已确认的同一人的 QQ 号，兼容缺 UID 的旧消息；与 sender 取并集。 */
  senderUin?: string;
}
export type BrowseDirection = 'older' | 'newer';
const BROWSE_TIME = 'COALESCE("40050",0)';

export function browseRow<T>(
  [id, ...fields]: SqlRow,
  timeIndex: number,
  bodyIndex: number,
  decode: (fields: SqlRow) => T,
) {
  const body = fields[bodyIndex];
  return {
    rowId: String(id),
    time: toBigint(fields[timeIndex]),
    body: body instanceof Uint8Array ? body : undefined,
    decode: () => decode(fields),
  };
}

export function browseConditions(
  clause: string,
  value: SqlValue,
  filter: BrowseFilter,
  cursor?: BrowseCursor,
  direction: BrowseDirection = 'older',
  time = BROWSE_TIME,
) {
  const where = [clause];
  const params: SqlValue[] = [value];
  if (filter.messageIds !== undefined) {
    where.push('"40001" IN (SELECT CAST(value AS INTEGER) FROM json_each(?))');
    params.push(JSON.stringify(filter.messageIds));
  }
  if (filter.start !== undefined) {
    where.push('"40050">=?');
    params.push(BigInt(filter.start));
  }
  if (filter.end !== undefined) {
    where.push('"40050"<=?');
    params.push(BigInt(filter.end));
  }
  if (filter.senderUin) {
    if (filter.sender) {
      where.push('("40020"=? OR "40033"=?)');
      params.push(filter.sender, filter.senderUin);
    } else {
      where.push('"40033"=?');
      params.push(filter.senderUin);
    }
  } else if (filter.sender) {
    where.push('("40020"=? OR "40033"=?)');
    params.push(filter.sender, filter.sender);
  }
  if (filter.senders?.length) {
    where.push(
      `("40020" IN (SELECT value FROM json_each(?)) OR "40033" IN (SELECT CAST(value AS INTEGER) FROM json_each(?) WHERE value NOT GLOB '*[^0-9]*'))`,
    );
    const senders = JSON.stringify(filter.senders);
    params.push(senders, senders);
  }
  if (cursor) {
    const comparison = direction === 'older' ? '<' : '>';
    // 显式时间范围让 SQLite 可以从索引定位，再按 rowid 处理同一秒的边界。
    where.push(`${time}${comparison}=? AND (${time}${comparison}? OR rowid${comparison}?)`);
    params.push(BigInt(cursor.time), BigInt(cursor.time), BigInt(cursor.rowId));
  }
  return { clause: where.join(' AND '), params };
}

/** 先按轻量时间键取页，再在同一读快照按 rowid 取正文，避免把 BLOB 放入候选排序。 */
export function queryBrowsePage(
  qq: QqDb,
  table: string,
  columns: readonly string[],
  partition: { clause: string; value: SqlValue },
  filter: BrowseFilter,
  cursor: BrowseCursor | undefined,
  limit: number,
  direction: BrowseDirection,
) {
  // 日期范围已排除 NULL，直接排序发送时间即可复用普通时间索引。
  const time = filter.start !== undefined || filter.end !== undefined ? '"40050"' : BROWSE_TIME;
  const query = browseConditions(
    partition.clause,
    partition.value,
    filter,
    cursor,
    direction,
    time,
  );
  const order = direction === 'older' ? 'DESC' : 'ASC';
  const fields = columns.map((column) => `m."${column}"`).join(',');
  return qq.query(
    `WITH page AS MATERIALIZED (
       SELECT rowid AS id,${time} AS send_time FROM ${table} WHERE ${query.clause}
       ORDER BY send_time ${order},id ${order} LIMIT ?
     )
     SELECT page.id,${fields} FROM page CROSS JOIN ${table} m ON m.rowid=page.id
     ORDER BY page.send_time ${order},page.id ${order}`,
    [...query.params, BigInt(limit)],
  );
}

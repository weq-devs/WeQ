import type { SqlValue } from '@weq/native';

export interface BrowseCursor {
  time: number | bigint;
  rowId: string;
}
export interface BrowseFilter {
  messageIds?: string[];
  start?: number;
  end?: number;
  sender?: string;
  /** 已确认的同一人的 QQ 号，兼容缺 UID 的旧消息；与 sender 取并集。 */
  senderUin?: string;
}
export type BrowseDirection = 'older' | 'newer';

export function browseConditions(
  clause: string,
  value: SqlValue,
  filter: BrowseFilter,
  cursor?: BrowseCursor,
  direction: BrowseDirection = 'older',
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
  if (cursor) {
    const comparison = direction === 'older' ? '<' : '>';
    where.push(
      `(COALESCE("40050",0)${comparison}? OR (COALESCE("40050",0)=? AND rowid${comparison}?))`,
    );
    params.push(BigInt(cursor.time), BigInt(cursor.time), BigInt(cursor.rowId));
  }
  return { clause: where.join(' AND '), params };
}

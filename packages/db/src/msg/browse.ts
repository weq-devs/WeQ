import type { SqlValue } from '@weq/native';

export interface BrowseCursor {
  time: number | bigint;
  rowId: string;
}
export interface BrowseFilter {
  start?: number;
  end?: number;
  sender?: string;
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
  if (filter.start !== undefined) {
    where.push('"40050">=?');
    params.push(BigInt(filter.start));
  }
  if (filter.end !== undefined) {
    where.push('"40050"<=?');
    params.push(BigInt(filter.end));
  }
  if (filter.sender) {
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

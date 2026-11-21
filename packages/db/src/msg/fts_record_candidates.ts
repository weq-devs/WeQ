import type { QqDb } from '../qq_db';
import { toBigint } from './util';
import type { BuddyMsgFtsHit } from './types';
import type { SqlRow } from '@weq/native';

export interface FtsRecordBounds {
  senderUid?: string;
  start?: number;
  end?: number;
}

/** 搜索正文字段，先应用可用索引字段，再交给业务层有界回查原消息。 */
export async function ftsRecordCandidates(
  qq: QqDb,
  table: 'buddy_msg_fts' | 'group_msg_fts',
  columns: string,
  toHit: (row: SqlRow) => BuddyMsgFtsHit,
  pattern: string,
  bounds: FtsRecordBounds,
  limit: number,
) {
  const where = [`"41701" LIKE ? ESCAPE '\\'`];
  const values: Array<string | bigint> = [pattern];
  if (bounds.senderUid) {
    where.push('"40020" = ?');
    values.push(bounds.senderUid);
  }
  if (bounds.start !== undefined) {
    where.push('"40050" >= ?');
    values.push(BigInt(bounds.start));
  }
  if (bounds.end !== undefined) {
    where.push('"40050" <= ?');
    values.push(BigInt(bounds.end));
  }
  const rows = await qq.query(
    `SELECT ${columns},"40027" FROM ${table} WHERE ${where.join(' AND ')}
      ORDER BY "40050" DESC, "40001" DESC LIMIT ?`,
    [...values, BigInt(limit)],
  );
  return rows.map((row) => ({ ...toHit(row), partition: toBigint(row[8]) }));
}

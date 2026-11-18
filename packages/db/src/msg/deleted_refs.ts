import type { SqlValue } from '@weq/native';
import type { QqDb } from '../qq_db';

/** 先按会话找候选 ID，只为真正进入当前页的记录读取正文 BLOB。 */
export async function listDeletedRefs(
  db: QqDb,
  table: string,
  partition: { clause: string; value: SqlValue },
  limit: number,
  before?: { time: number; id?: string },
) {
  const time = 'COALESCE("40050", 0)';
  const id = 'CAST("40001" AS TEXT)';
  const rows = await db.query(
    `SELECT ${id}, ${time} FROM ${table}
     WHERE ${partition.clause} AND "40011" = 1 AND "40012" = 1
     ${before ? (before.id === undefined ? `AND ${time} < ?` : `AND (${time}, ${id}) < (?, ?)`) : ''}
     ORDER BY ${time} DESC, ${id} DESC LIMIT ?`,
    [
      partition.value,
      ...(before ? [before.time, ...(before.id === undefined ? [] : [before.id])] : []),
      limit,
    ],
  );
  return rows.map(([msgId, sendTime]) => ({ msgId: String(msgId), sendTime: String(sendTime) }));
}

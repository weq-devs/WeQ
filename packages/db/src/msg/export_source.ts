import type { SqlValue } from '@weq/native';
import type { QqDb } from '../qq_db';

export interface MessageSourceRow {
  table: string;
  rowId: string;
  columns: Record<string, SqlValue>;
}
/** 导出完整档按实际表结构枚举列，不把界面查询的固定 SELECT 当成全量来源。 */
export async function readMessageSourceRows(
  qq: QqDb,
  table: string,
  partition: string,
  conversation: SqlValue,
  ids: readonly string[],
  selectedColumns?: readonly string[],
): Promise<MessageSourceRow[]> {
  if (!ids.length) return [];
  if (!/^[a-z_][a-z0-9_]*$/i.test(table) || !/^\d+$/.test(partition))
    throw new Error('消息来源表或分区字段无效。');
  const columns = selectedColumns
    ? [...selectedColumns]
    : (await qq.query('SELECT name FROM pragma_table_info(?)', [table])).map((row) =>
        String(row[0]),
      );
  if (!columns.includes('40001') || !columns.includes(partition))
    throw new Error('消息来源表缺少身份或分区字段。');
  const quoted = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(',');
  const result: MessageSourceRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 256) {
    const batch = ids.slice(offset, offset + 256).map((id) => BigInt(id));
    const rows = await qq.query(
      `SELECT rowid,${quoted} FROM "${table}" WHERE "${partition}"=? AND "40001" IN (${batch.map(() => '?').join(',')}) ORDER BY rowid`,
      [conversation, ...batch],
    );
    for (const row of rows)
      result.push({
        table,
        rowId: String(row[0]),
        columns: Object.fromEntries(
          columns.map((column, index) => [column, row[index + 1] ?? null]),
        ),
      });
  }
  return result;
}

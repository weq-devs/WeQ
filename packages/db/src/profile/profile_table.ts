import type { QqDb } from '../qq_db';

export interface ProfileTableSchema {
  table: string;
  columns: ReadonlySet<string>;
}

/** 只探测真实资料表，不触碰依赖 QQ 专有 tokenizer 的 FTS 表。 */
export async function resolveProfileTableSchema(
  qq: Pick<QqDb, 'query'>,
): Promise<ProfileTableSchema> {
  const rows = await qq.query("SELECT name FROM sqlite_master WHERE type = 'table'");
  const tables = rows
    .map((row) => String(row[0] ?? ''))
    .filter((name) => /^profile_info_v\d+$/.test(name));
  tables.sort((a, b) => Number(b.slice(14)) - Number(a.slice(14)));
  for (const table of tables) {
    const fields = await qq.query('SELECT name FROM pragma_table_info(?)', [table]);
    const columns = new Set(fields.map((row) => String(row[0])));
    if (['1000', '1002', '20002'].every((field) => columns.has(field))) return { table, columns };
  }
  throw new Error('未找到兼容的 QQ 资料表');
}

import type { SqlRow, SqlValue } from '@weq/native';
import type { QqDb } from '../qq_db';
import { databaseRequestSignal, withDatabasePriority } from '../query_schedule';
import { toBigint } from './util';
import type { SourceMsgSearchDb, SourceSearchPartition } from './source_search';

const SCAN_ROWS = 512;
const DETAIL_ROWS = 64;

export const ftsLikePattern = (keyword: string) => `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;

interface ContentSearch {
  table: 'buddy_msg_fts' | 'group_msg_fts';
  columns: string;
  keyword: string;
  poolSize: number;
  filenameOnly?: boolean;
  partition?: SourceSearchPartition;
  index?: SourceMsgSearchDb;
}
interface Candidate {
  rowId: bigint;
  time: bigint | null;
}

function newestFirst(left: Candidate, right: Candidate) {
  if (left.time !== right.time) {
    if (left.time === null) return 1;
    if (right.time === null) return -1;
    return left.time > right.time ? -1 : 1;
  }
  return left.rowId > right.rowId ? -1 : left.rowId < right.rowId ? 1 : 0;
}

/** LIMIT 约束候选池；稀疏命中按真实 rowid 分页，每批只回传命中的键和时间。 */
export function searchFtsContent(qq: QqDb, input: ContentSearch): Promise<SqlRow[]> {
  const signal = databaseRequestSignal();
  return withDatabasePriority('background', () => search(qq, input), signal);
}

export async function searchFtsFilePreview(
  keyword: string,
  limit: number,
  index?: SourceMsgSearchDb,
): Promise<SqlRow[] | undefined> {
  const rows = await index?.likeCandidates({
    keyword,
    limit: limit + 1,
    fields: 'file',
    order: 'time',
  });
  // 原查询只按时间排序。时间相同时保留原查询选出的文件及顺序。
  if (rows?.some((row, i) => i > 0 && String(row[5]) === String(rows[i - 1]?.[5]))) return;
  return rows;
}

async function search(
  qq: QqDb,
  { table, columns, keyword, poolSize, filenameOnly, partition, index }: ContentSearch,
): Promise<SqlRow[]> {
  const signal = databaseRequestSignal();
  const indexHits = await index?.likeCandidates({
    keyword,
    limit: poolSize,
    fields: filenameOnly ? 'file' : 'both',
    order: 'rowid',
    partition,
  });
  signal?.throwIfAborted();
  if (indexHits) return indexHits;
  const pattern = ftsLikePattern(keyword);
  const needle = '(SELECT pattern FROM needle)';
  const file = `"41702" LIKE ${needle} ESCAPE '\\'`;
  const like = filenameOnly ? file : `("41701" LIKE ${needle} ESCAPE '\\' OR ${file})`;
  const partitionMatch = partition ? `"${partition.column}"=?` : undefined;
  const match = partitionMatch ? `${like} AND ${partitionMatch}` : like;
  const prefix = 'WITH needle(pattern) AS (VALUES(?))';
  if (qq.supportsReadBudget) {
    try {
      // 热词或使用分区索引时复用原查询；长扫描到预算后进入下面的有界分页。
      const { rows, limit } = await qq.queryPage(
        `${prefix} SELECT ${columns} FROM ${table} WHERE ${match}
         ORDER BY "40050" DESC, rowid DESC LIMIT ?`,
        partition ? [pattern, partition.value] : [pattern],
        poolSize,
      );
      signal?.throwIfAborted();
      if (limit === poolSize || rows.length < limit) return rows;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('database_query_execution_timeout'))
        throw error;
    }
  }

  let candidates: Candidate[] = [];
  let cursor: SqlValue | undefined;
  let pageSize = SCAN_ROWS;
  // 有索引就按会话翻页；旧库或 UID 兜底没索引时，按全表 rowid 划定每批读取上限。
  let indexed = Boolean(partition && (await qq.hasLeadingIndex(table, partition.column)));
  for (;;) {
    signal?.throwIfAborted();
    const args: SqlValue[] = partition ? [pattern, partition.value] : [pattern];
    const scope = partition && !indexed ? ', scope(value) AS (VALUES(?))' : '';
    const scopedMatch =
      partition && !indexed ? `${like} AND "${partition.column}"=(SELECT value FROM scope)` : like;
    const projection = ['rowid AS scan_key', '"40050"', '"41701"', '"41702"'];
    if (partition && !indexed) projection.push(`"${partition.column}"`);
    const bounds = [
      indexed ? partitionMatch : undefined,
      cursor === undefined ? undefined : 'rowid < ?',
    ]
      .filter(Boolean)
      .join(' AND ');
    if (cursor !== undefined) args.push(cursor);
    let page: Awaited<ReturnType<QqDb['queryPage']>>;
    try {
      page = await qq.queryPage(
        `${prefix}${scope}, page AS MATERIALIZED (
           SELECT ${projection.join(',')} FROM ${table}
           ${bounds ? `WHERE ${bounds}` : ''} ORDER BY rowid DESC LIMIT ?
         )
         SELECT scan_key, "40050" FROM page WHERE ${scopedMatch}
         UNION ALL SELECT MIN(scan_key), COUNT(*) FROM page`,
        args,
        pageSize,
      );
    } catch (error) {
      // 某些库的索引不能按 rowid 直接取页，超预算后从同一游标改走有界扫描。
      if (
        !indexed ||
        !(error instanceof Error) ||
        !error.message.includes('database_query_execution_timeout')
      )
        throw error;
      indexed = false;
      continue;
    }
    signal?.throwIfAborted();
    pageSize = page.limit;
    const end = page.rows.pop();
    cursor = end?.[0] ?? undefined;
    if (page.rows.length) {
      for (const [rowId, time] of page.rows)
        candidates.push({ rowId: toBigint(rowId), time: time == null ? null : toBigint(time) });
      candidates = candidates.sort(newestFirst).slice(0, poolSize);
    }
    if (cursor === undefined || Number(end?.[1]) < pageSize) break;
    await new Promise<void>((done) => setImmediate(done));
  }

  const details = new Map<bigint, SqlRow>();
  for (let i = 0; i < candidates.length; i += DETAIL_ROWS) {
    signal?.throwIfAborted();
    const ids = candidates.slice(i, i + DETAIL_ROWS).map(({ rowId }) => String(rowId));
    const rows = await qq.query(
      `${prefix} SELECT rowid,${columns} FROM ${table}
       WHERE rowid IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) AND ${match}`,
      partition ? [pattern, JSON.stringify(ids), partition.value] : [pattern, JSON.stringify(ids)],
    );
    signal?.throwIfAborted();
    for (const row of rows) details.set(toBigint(row[0]), row.slice(1));
  }
  return candidates.flatMap(({ rowId }) => {
    const detail = details.get(rowId);
    return detail ? [detail] : [];
  });
}

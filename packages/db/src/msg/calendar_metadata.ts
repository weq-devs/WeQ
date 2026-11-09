import type { SqlRow, SqlValue } from '@weq/native';
import type { QqDb } from '../qq_db';
import { decodeBody } from './util';

export type CalendarTable =
  | 'group_msg_table'
  | 'c2c_msg_table'
  | 'dataline_msg_table'
  | 'service_assistant_msg_table'
  | 'guild_msg_table';
export interface CalendarCursor {
  time: number;
  source: string | null;
  id: string;
}
export interface CalendarMetadata {
  id: string;
  seq: string;
  time: number;
  conv: string;
  visible: boolean;
}
const columns: Record<CalendarTable, string> = {
  group_msg_table: '40027',
  c2c_msg_table: '40021',
  dataline_msg_table: '40021',
  service_assistant_msg_table: '40035',
  guild_msg_table: '40027',
};

/** 只读取计数/定位元数据；卡片专用源须验证其现有 ARK-only 展示条件。 */
export class CalendarMetadataDb {
  private indexed: Promise<boolean> | undefined;
  constructor(
    private readonly qq: QqDb,
    readonly table: CalendarTable,
  ) {}

  private timeIndex(): Promise<boolean> {
    if (this.indexed) return this.indexed;
    this.indexed = (async () => {
      const indexes = await this.qq.query(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?",
        [this.table],
      );
      for (const [name] of indexes) {
        const info = await this.qq.query('SELECT name FROM pragma_index_info(?) ORDER BY seqno', [
          String(name),
        ]);
        if (info[0]?.[0] === '40050' && info[1]?.[0] === '40040') return true;
      }
      return false;
    })().catch((error: unknown) => {
      this.indexed = undefined;
      throw error;
    });
    return this.indexed;
  }

  private filter(convs: string[], start: number, end: number, hidden: string[]) {
    if (!convs.length) throw new Error('日历会话范围为空');
    const params: SqlValue[] = [BigInt(start), BigInt(end), ...convs];
    let sql = `"40050">=? AND "40050"<? AND CAST("${columns[this.table]}" AS TEXT) IN (${convs.map(() => '?').join(',')})`;
    if (hidden.length) {
      sql += ` AND CAST("40001" AS TEXT) NOT IN (${hidden.map(() => '?').join(',')})`;
      params.push(...hidden);
    }
    return { sql, params };
  }

  async count(
    convs: string[],
    start: number,
    end: number,
    hidden: string[],
  ): Promise<number | null> {
    if (convs.length + hidden.length > 2048 || !(await this.timeIndex())) return null;
    const filter = this.filter(convs, start, end, hidden);
    const rows = await this.qq.query(
      `SELECT COUNT(*) FROM ${this.table} WHERE ${filter.sql}`,
      filter.params,
    );
    return Number(rows[0]?.[0] ?? 0);
  }

  async page(
    start: number,
    end: number,
    cursor: CalendarCursor | undefined,
    limit: number,
    ark = false,
  ): Promise<{ items: CalendarMetadata[]; cursor: CalendarCursor | undefined; done: boolean }> {
    const indexed = await this.timeIndex();
    const params: SqlValue[] = [];
    let where = '';
    if (indexed) {
      where = '"40050">=? AND "40050"<?';
      params.push(BigInt(start), BigInt(end));
      if (cursor) {
        if (cursor.source === null) {
          where +=
            ' AND ("40050">? OR ("40050"=? AND ("40040" IS NOT NULL OR ("40040" IS NULL AND rowid>?))))';
          params.push(BigInt(cursor.time), BigInt(cursor.time), BigInt(cursor.id));
        } else {
          where += ' AND ("40050","40040",rowid)>(?,?,?)';
          params.push(BigInt(cursor.time), BigInt(cursor.source), BigInt(cursor.id));
        }
      }
    } else if (cursor) {
      where = 'rowid>?';
      params.push(BigInt(cursor.id));
    }
    const order = indexed ? '"40050","40040",rowid' : 'rowid';
    const rows = await this.qq.query(
      `SELECT rowid,"40003","40050","${columns[this.table]}",${indexed ? '"40040"' : 'NULL'}${ark ? ',"40800"' : ''} FROM ${this.table}${where ? ` WHERE ${where}` : ''} ORDER BY ${order} LIMIT ?`,
      [...params, BigInt(Math.max(1, Math.min(256, limit)))],
    );
    const last = rows.at(-1);
    return {
      items: rows
        .filter((row) => Number(row[2]) >= start && Number(row[2]) < end)
        .map((row) => ({
          id: String(row[0]),
          seq: String(row[1] ?? '0'),
          time: Number(row[2]),
          conv: String(row[3] ?? ''),
          visible: !ark || arkVisible(row),
        })),
      cursor: last
        ? {
            id: String(last[0]),
            time: Number(last[2]),
            source: last[4] === null ? null : String(last[4]),
          }
        : cursor,
      done: rows.length < limit,
    };
  }

  async exists(id: string, conv?: string, time?: number): Promise<boolean> {
    return (
      (
        await this.qq.query(
          `SELECT 1 FROM ${this.table} WHERE rowid=?${conv !== undefined ? ` AND CAST("${columns[this.table]}" AS TEXT)=? AND "40050"=?` : ''}`,
          [BigInt(id), ...(conv !== undefined ? [conv, time ?? 0] : [])],
        )
      ).length > 0
    );
  }
  async localTimeline(conv: string, sequences: string[], sortNo?: bigint) {
    if (!sequences.length) return [];
    const column =
      this.table === 'c2c_msg_table' && sortNo !== undefined ? '40027' : columns[this.table];
    const rows = await this.qq.query(
      `SELECT "40001","40003","40050","40002","40020" FROM ${this.table} WHERE "${column}"=? AND "40003" IN (${sequences.map(() => '?').join(',')}) LIMIT 257`,
      [sortNo ?? conv, ...sequences.map(BigInt)],
    );
    if (rows.length > 256) throw new Error('同序号本地记录过多，日历去重统计已暂停');
    return rows.map((row) => ({
      msgId: String(row[0]),
      msgSeq: String(row[1]),
      sendTime: String(row[2]),
      msgRandom: String(row[3] ?? ''),
      senderUid: String(row[4] ?? ''),
    }));
  }
}

function arkVisible(row: SqlRow): boolean {
  const first = decodeBody(row[5]).find((element) => element.kind === 'ark');
  if (first?.kind !== 'ark') return false;
  try {
    const prompt = JSON.parse(first.arkData).prompt;
    return typeof prompt === 'string' && prompt.length > 0;
  } catch {
    return false;
  }
}

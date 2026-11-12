/**
 * `buddy_list` — Global buddy (friend) list.
 *
 * Column map:
 *   1000   uid         (TEXT)
 *   1001   qid         (TEXT)
 *   1002   uin         (INTEGER)
 *   25007  categoryId  (INTEGER) - Null if in default group
 */

import type { NtHelperBinding, SqlRow, SqlValue, DatabaseAlgorithms } from '@weq/native';
import { QqDb } from '../qq_db';

export interface Buddy {
  uid: string;
  qid: string;
  uin: bigint;
  categoryId: number; // 0 for default
}

export interface BuddyDbOptions {
  dbPath: string;
  key?: string;
  algo?: DatabaseAlgorithms;
}

const BUDDY_COLUMNS = ['1000', '1001', '1002', '25007'];
const SELECT_COLUMNS = BUDDY_COLUMNS.map((column) => `"${column}"`).join(',');

export class BuddyDb {
  get dbPath(): string {
    return this.qq.dbPath;
  }

  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: BuddyDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * List buddies. Omit limit to fetch all rows (for AgentLab clone picker).
   */
  async listBuddies(limit?: number, offset = 0): Promise<Buddy[]> {
    const result: Buddy[] = [];
    if (limit === 0) return result;
    let skip = limit === undefined ? 0 : Math.max(0, offset);
    for await (const rows of this.qq.rowidPages('buddy_list', BUDDY_COLUMNS)) {
      for (const row of rows) {
        if (skip > 0) {
          skip--;
          continue;
        }
        result.push(rowToBuddy(row.slice(1)));
        if (limit !== undefined && limit > 0 && result.length >= limit) return result;
      }
    }
    return result;
  }

  /**
   * Get a single buddy by UID.
   */
  async getBuddy(uid: string): Promise<Buddy | null> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM buddy_list WHERE "1000" = ? LIMIT 1`,
      [uid],
    );
    if (rows.length === 0) return null;
    return rowToBuddy(rows[0]!);
  }

  close(): void {
    this.qq.close();
  }
}

function rowToBuddy(row: SqlRow): Buddy {
  return {
    uid: String(row[0] ?? ''),
    qid: String(row[1] ?? ''),
    uin: toBigint(row[2]),
    categoryId: Number(row[3] ?? 0),
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

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
  key: string;
  algo: DatabaseAlgorithms;
}

const SELECT_COLUMNS = `"1000","1001","1002","25007"`;

export class BuddyDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: BuddyDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * List all buddies with pagination.
   */
  async listBuddies(limit = 200, offset = 0): Promise<Buddy[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM buddy_list LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map(rowToBuddy);
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

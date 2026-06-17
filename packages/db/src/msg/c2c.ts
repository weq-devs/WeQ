/**
 * `c2c_msg_table` — private-chat (one-on-one) messages.
 *
 * Column map (subset we read):
 *   40001  msgId       (INTEGER, PRIMARY KEY)
 *   40003  msgSeq      (INTEGER — per-peer incrementing sequence)
 *   40020  senderUid   (TEXT)
 *   40021  targetUid   (TEXT — the peer uid; app-facing conversation key)
 *   40027  sortNo      (INTEGER — per-account peer index; the *indexed* key)
 *   40030  targetUin   (INTEGER — peer QQ number)
 *   40033  senderUin   (INTEGER)
 *   40050  sendTime    (INTEGER, unix seconds)
 *   40800  msgBody     (BLOB — protobuf repeated ElementWire)
 *
 * Partitioning: every useful composite index is on `40027` (the peer sort
 * number from `nt_uid_mapping_table`), NOT on `40021` (uid, unindexed). So the
 * fast path queries by `sortNo` and orders by `40003` — hitting the
 * `(40027,40003)` index. Callers resolve uid → sortNo via the session's
 * resident `UidMap`; when that lookup misses we fall back to a `40021` scan so
 * the conversation still loads (just slower).
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { C2cMsg } from './types';
import { decodeBody, toBigint, toStr } from './util';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40001","40020","40021","40030","40033","40050","40800","40003"`;

/**
 * Which partition column to filter a c2c conversation by. Prefer `sortNo`
 * (column 40027 — indexed); `uid` (column 40021 — unindexed) is the fallback
 * for peers missing from the uid map.
 */
export type C2cPartition = { sortNo: bigint } | { uid: string };

function partitionWhere(part: C2cPartition): { clause: string; value: SqlValue } {
  return 'sortNo' in part
    ? { clause: '"40027" = ?', value: part.sortNo }
    : { clause: '"40021" = ?', value: part.uid };
}

export interface C2cMsgDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. */
  key: string;
  /** Database algorithms. */
  algo: DatabaseAlgorithms;
}

export class C2cMsgDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: C2cMsgDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** Newest N messages in one conversation, newest-first (DESC by seq). */
  async listLatest(part: C2cPartition, limit = 50): Promise<C2cMsg[]> {
    const { clause, value } = partitionWhere(part);
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM c2c_msg_table
        WHERE ${clause}
        ORDER BY "40003" DESC
        LIMIT ?`,
      [value, BigInt(limit)],
    );
    return rows.map(rowToC2cMsg);
  }

  /** The page of messages just older than `beforeSeq` (exclusive), newest-first. */
  async listBefore(part: C2cPartition, beforeSeq: bigint, limit = 50): Promise<C2cMsg[]> {
    const { clause, value } = partitionWhere(part);
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM c2c_msg_table
        WHERE ${clause} AND "40003" < ?
        ORDER BY "40003" DESC
        LIMIT ?`,
      [value, beforeSeq, BigInt(limit)],
    );
    return rows.map(rowToC2cMsg);
  }

  /** The page of messages just newer than `afterSeq` (exclusive), oldest-first. */
  async listAfter(part: C2cPartition, afterSeq: bigint, limit = 50): Promise<C2cMsg[]> {
    const { clause, value } = partitionWhere(part);
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM c2c_msg_table
        WHERE ${clause} AND "40003" > ?
        ORDER BY "40003" ASC
        LIMIT ?`,
      [value, afterSeq, BigInt(limit)],
    );
    return rows.map(rowToC2cMsg);
  }

  /**
   * Messages with seq >= `sinceSeq`, newest-first, capped at `limit`. The
   * "re-read the currently-loaded window" query — picks up new tail messages
   * plus in-place edits (recall) within the window.
   */
  async listFrom(part: C2cPartition, sinceSeq: bigint, limit = 500): Promise<C2cMsg[]> {
    const { clause, value } = partitionWhere(part);
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM c2c_msg_table
        WHERE ${clause} AND "40003" >= ?
        ORDER BY "40003" DESC
        LIMIT ?`,
      [value, sinceSeq, BigInt(limit)],
    );
    return rows.map(rowToC2cMsg);
  }

  /** Most recent N messages across all peers, newest first. Useful for "test dump". */
  async listRecent(limit = 50, offset = 0): Promise<C2cMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM c2c_msg_table
        ORDER BY "40050" DESC
        LIMIT ? OFFSET ?`,
      [BigInt(limit), BigInt(offset)],
    );
    return rows.map(rowToC2cMsg);
  }

  /** Largest SQLite rowid currently in the table, or 0n if empty. */
  async latestRowId(): Promise<bigint> {
    const rows = await this.qq.query(`SELECT MAX(rowid) FROM c2c_msg_table`);
    return toBigint(rows[0]?.[0]);
  }

  /**
   * Rows inserted after `sinceRowId` (rowid strictly greater), oldest-first.
   * rowid is monotonic on insert, so this reliably finds newly-arrived
   * messages regardless of msgId ordering — the basis of the new-message
   * notification signal.
   */
  async listSinceRowId(sinceRowId: bigint, limit = 500): Promise<C2cMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM c2c_msg_table
        WHERE rowid > ?
        ORDER BY rowid ASC
        LIMIT ?`,
      [sinceRowId, BigInt(limit)],
    );
    return rows.map(rowToC2cMsg);
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}

function rowToC2cMsg(row: SqlRow): C2cMsg {
  return {
    msgId: toBigint(row[0]),
    senderUid: toStr(row[1]),
    targetUid: toStr(row[2]),
    targetUin: toBigint(row[3]),
    senderUin: toBigint(row[4]),
    sendTime: toBigint(row[5]),
    elements: decodeBody(row[6]),
    msgSeq: toBigint(row[7]),
  };
}

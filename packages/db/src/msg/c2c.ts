/**
 * `c2c_msg_table` — private-chat (one-on-one) messages.
 *
 * Column map (subset we read):
 *   40001  msgId       (INTEGER)
 *   40020  senderUid   (TEXT)
 *   40021  targetUid   (TEXT — the peer; conversation key)
 *   40030  targetUin   (INTEGER — peer QQ number)
 *   40033  senderUin   (INTEGER)
 *   40050  sendTime    (INTEGER, unix seconds)
 *   40800  msgBody     (BLOB — protobuf repeated ElementWire)
 *
 * Conversations are keyed by `targetUid` (40021), not uin — uin can be
 * missing/zero on some rows. The 40800 column is decoded by `@weq/codec`.
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';
import type { C2cMsg } from './types';
import { decodeBody, toBigint, toStr } from './util';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40001","40020","40021","40030","40033","40050","40800"`;

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

  /**
   * Most recent N messages with one conversation target (peer uid, column
   * 40021), newest first.
   */
  async listMessagesWithTarget(targetUid: string, limit = 50, offset = 0): Promise<C2cMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM c2c_msg_table
        WHERE "40021" = ?
        ORDER BY "40050" DESC
        LIMIT ? OFFSET ?`,
      [targetUid, BigInt(limit), BigInt(offset)],
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

  /**
   * Messages with msgId (column 40001) strictly greater than `sinceMsgId`,
   * oldest-first (ascending msgId). This is the "what arrived since I last
   * looked" query the file-watcher hook uses to compute deltas; `limit`
   * caps the fan-out so a stale baseline can't dump the whole table.
   */
  async listSince(sinceMsgId: bigint, limit = 500): Promise<C2cMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM c2c_msg_table
        WHERE "40001" > ?
        ORDER BY "40001" ASC
        LIMIT ?`,
      [sinceMsgId, BigInt(limit)],
    );
    return rows.map(rowToC2cMsg);
  }

  /** Largest msgId (column 40001) currently in the table, or 0n if empty. */
  async latestMsgId(): Promise<bigint> {
    const rows = await this.qq.query(`SELECT MAX("40001") FROM c2c_msg_table`);
    return toBigint(rows[0]?.[0]);
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
  };
}

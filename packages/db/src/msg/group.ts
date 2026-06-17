/**
 * `group_msg_table` — group-chat messages.
 *
 * Same column layout as c2c_msg_table, the conversation key being the group
 * code instead of a peer uid:
 *   40001  msgId           (INTEGER)
 *   40003  msgSeq          (INTEGER — per-group incrementing sequence)
 *   40020  senderUid       (TEXT)
 *   40027  targetGroupCode (INTEGER as text — 群号; conversation key, indexed)
 *   40033  senderUin       (INTEGER — sender QQ number)
 *   40050  sendTime        (INTEGER, unix seconds)
 *   40058  dayTimestamp    (INTEGER — midnight timestamp of the day)
 *   40800  msgBody         (BLOB — protobuf repeated ElementWire)
 *   40062  setEmoji        (BLOB — protobuf repeated sticker reactions / 贴表情)
 *
 * Group code (40027) is the indexed partition key; all conversation queries
 * order by 40003 to hit the `(40027,40003)` composite index.
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';
import type { GroupMsg } from './types';
import { decodeBody, decodeEmoji, toBigint, toStr } from './util';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40001","40020","40027","40033","40050","40800","40062","40003"`;

export interface GroupMsgDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. */
  key: string;
  /** Database algorithms. */
  algo: DatabaseAlgorithms;
}

export class GroupMsgDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GroupMsgDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** Newest N messages in one group, newest-first (DESC by seq). */
  async listLatest(targetGroupCode: string, limit = 50): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ?
        ORDER BY "40003" DESC
        LIMIT ?`,
      [targetGroupCode, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /** The page of messages just older than `beforeSeq` (exclusive), newest-first. */
  async listBefore(targetGroupCode: string, beforeSeq: bigint, limit = 50): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ? AND "40003" < ?
        ORDER BY "40003" DESC
        LIMIT ?`,
      [targetGroupCode, beforeSeq, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /** The page of messages just newer than `afterSeq` (exclusive), oldest-first. */
  async listAfter(targetGroupCode: string, afterSeq: bigint, limit = 50): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ? AND "40003" > ?
        ORDER BY "40003" ASC
        LIMIT ?`,
      [targetGroupCode, afterSeq, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /**
   * Messages with seq >= `sinceSeq`, newest-first, capped at `limit`. The
   * "re-read the currently-loaded window" query — picks up new tail messages
   * plus in-place edits (recall / sticker reactions) within the window.
   */
  async listFrom(targetGroupCode: string, sinceSeq: bigint, limit = 500): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ? AND "40003" >= ?
        ORDER BY "40003" DESC
        LIMIT ?`,
      [targetGroupCode, sinceSeq, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /** Most recent N messages across all groups, newest first. Useful for "test dump". */
  async listRecent(limit = 50, offset = 0): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        ORDER BY "40001" DESC
        LIMIT ? OFFSET ?`,
      [BigInt(limit), BigInt(offset)],
    );
    return rows.map(rowToGroupMsg);
  }

  /** Largest SQLite rowid currently in the table, or 0n if empty. */
  async latestRowId(): Promise<bigint> {
    const rows = await this.qq.query(`SELECT MAX(rowid) FROM group_msg_table`);
    return toBigint(rows[0]?.[0]);
  }

  /**
   * Rows inserted after `sinceRowId` (rowid strictly greater), oldest-first.
   * rowid is monotonic on insert, so this reliably finds newly-arrived group
   * messages even when their msgId sorts below an older gray-tip's msgId —
   * the basis of the new-message notification signal.
   */
  async listSinceRowId(sinceRowId: bigint, limit = 500): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE rowid > ?
        ORDER BY rowid ASC
        LIMIT ?`,
      [sinceRowId, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}

function rowToGroupMsg(row: SqlRow): GroupMsg {
  return {
    msgId: toBigint(row[0]),
    senderUid: toStr(row[1]),
    targetGroupCode: toStr(row[2]),
    senderUin: toBigint(row[3]),
    sendTime: toBigint(row[4]),
    elements: decodeBody(row[5]),
    setEmojiList: decodeEmoji(row[6]),
    msgSeq: toBigint(row[7]),
  };
}

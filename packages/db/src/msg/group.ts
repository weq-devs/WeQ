/**
 * `group_msg_table` — group-chat messages.
 *
 * Same column layout as c2c_msg_table, the conversation key being the group
 * code instead of a peer uid:
 *   40001  msgId           (INTEGER)
 *   40020  senderUid       (TEXT)
 *   40021  targetGroupCode (INTEGER as text — 群号; conversation key)
 *   40033  senderUin       (INTEGER — sender QQ number)
 *   40050  sendTime        (INTEGER, unix seconds)
 *   40800  msgBody         (BLOB — protobuf repeated ElementWire)
 *   40062  setEmoji        (BLOB — protobuf repeated sticker reactions / 贴表情)
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';
import type { GroupMsg } from './types';
import { decodeBody, decodeEmoji, toBigint, toStr } from './util';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40001","40020","40027","40033","40050","40800","40062"`;

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

  /**
   * Most recent N messages in one group (internal group code, column 40027),
   * newest first.
   */
  async listMessagesWithTarget(targetGroupCode: string, limit = 50, offset = 0): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ?
        ORDER BY "40050" DESC
        LIMIT ? OFFSET ?`,
      [targetGroupCode, BigInt(limit), BigInt(offset)],
    );
    return rows.map(rowToGroupMsg);
  }

  /** Most recent N messages across all groups, newest first. Useful for "test dump". */
  async listRecent(limit = 50, offset = 0): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        ORDER BY "40050" DESC
        LIMIT ? OFFSET ?`,
      [BigInt(limit), BigInt(offset)],
    );
    return rows.map(rowToGroupMsg);
  }

  /**
   * Messages with msgId (column 40001) strictly greater than `sinceMsgId`,
   * oldest-first (ascending msgId). The group counterpart of
   * `C2cMsgDb.listSince` — used by the file-watcher hook to compute deltas;
   * `limit` caps the fan-out so a stale baseline can't dump the whole table.
   */
  async listSince(sinceMsgId: bigint, limit = 500): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40001" > ?
        ORDER BY "40001" ASC
        LIMIT ?`,
      [sinceMsgId, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /** Largest msgId (column 40001) currently in the table, or 0n if empty. */
  async latestMsgId(): Promise<bigint> {
    const rows = await this.qq.query(`SELECT MAX("40001") FROM group_msg_table`);
    return toBigint(rows[0]?.[0]);
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
  };
}

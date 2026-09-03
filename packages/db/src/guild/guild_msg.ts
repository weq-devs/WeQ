/**
 * 频道私聊 messages (`guild_msg_table` in guild_msg.db).
 *
 * The table stores EVERY guild message (channel chats + DMs). A DM is a
 * partition of rows whose column 40027 equals the direct conversation's node
 * id (the same 40027 in `direct_node_list_table`). The usable composite
 * indexes are (40027, 40003) and (40002, 40003, 40027), so queries always
 * filter by 40027 = nodeId and order by 40003 - never by the text columns.
 *
 * Column map (subset we read):
 *   40001  msgId        (INTEGER, PRIMARY KEY)
 *   40003  msgSeq       (INTEGER - per-conversation sequence)
 *   40027  nodeId       (INTEGER - conversation partition)
 *   40026  senderTinyId (INTEGER)
 *   40025  senderTinyIdText (TEXT, same id)
 *   40013  sendType     (INTEGER - 0 = peer sent; 2 = this account sent)
 *   40050  sendTime     (INTEGER, unix seconds)
 *   40011  msgType      (INTEGER)
 *   40012  subType      (INTEGER)
 *   40800  msgBody      (BLOB - protobuf repeated ElementWire)
 *   40801  dress        (BLOB - per-message decoration)
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';
import type { GuildDirectMsg } from './types';
import { decodeBody, decodeDress, toBigint } from '../msg/util';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40001","40003","40027","40026","40025","40013","40050","40800","40011","40012","40801"`;

/** Newest first. Same-seq rows fall back to time then msgId for a stable run. */
const ORDER_NEWEST_FIRST = `ORDER BY "40003" DESC, "40050" DESC, "40001" DESC`;
const ORDER_OLDEST_FIRST = `ORDER BY "40003" ASC, "40050" ASC, "40001" ASC`;

export interface GuildDirectMsgDbOptions {
  /** Absolute path to guild_msg.db. */
  dbPath: string;
  /** SQLCipher key (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

/** 频道私聊 message-table accessor (guild_msg.db). */
export class GuildDirectMsgDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GuildDirectMsgDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** Newest N messages of one DM conversation, newest-first (seq DESC). */
  async listLatest(nodeId: bigint, limit = 50): Promise<GuildDirectMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM guild_msg_table
        WHERE "40027" = ?
        ${ORDER_NEWEST_FIRST}
        LIMIT ?`,
      [nodeId, BigInt(limit)],
    );
    return rows.map(rowToGuildDirectMsg);
  }

  /** The page just older than `beforeSeq` (exclusive), newest-first. */
  async listBefore(nodeId: bigint, beforeSeq: bigint, limit = 50): Promise<GuildDirectMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM guild_msg_table
        WHERE "40027" = ? AND "40003" < ?
        ${ORDER_NEWEST_FIRST}
        LIMIT ?`,
      [nodeId, beforeSeq, BigInt(limit)],
    );
    return rows.map(rowToGuildDirectMsg);
  }

  /** The page just newer than `afterSeq` (exclusive), oldest-first. */
  async listAfter(nodeId: bigint, afterSeq: bigint, limit = 50): Promise<GuildDirectMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM guild_msg_table
        WHERE "40027" = ? AND "40003" > ?
        ${ORDER_OLDEST_FIRST}
        LIMIT ?`,
      [nodeId, afterSeq, BigInt(limit)],
    );
    return rows.map(rowToGuildDirectMsg);
  }

  /** Drop the cached native connection. */
  close(): void {
    this.qq.close();
  }
}

function rowToGuildDirectMsg(row: SqlRow): GuildDirectMsg {
  const idInt = toBigint(row[3]);
  const idText = toBigint(row[4]);
  return {
    msgId: toBigint(row[0]),
    msgSeq: toBigint(row[1]),
    nodeId: toBigint(row[2]),
    senderTinyId: idInt !== 0n ? idInt : idText,
    sendType: toBigint(row[5]),
    sendTime: toBigint(row[6]),
    elements: decodeBody(row[7]),
    msgType: toBigint(row[8]),
    subType: toBigint(row[9]),
    decoration: decodeDress(row[10]),
  };
}

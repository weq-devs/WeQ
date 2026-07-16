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

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { GroupMsg } from './types';
import { decodeBody, decodeEmoji, toBigint, toStr } from './util';
import { appendClonedRow, type AppendMsgFields, type AppendMsgResult } from './append';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40001","40020","40027","40033","40050","40800","40062","40003","40011","40012"`;

export interface GroupMsgDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
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
   * Batch-read messages oldest-first, starting from `afterSeq` (0n to begin).
   * Optionally filters by sendTime range (unix seconds). Use for analytics /
   * full-group scans that need to process every message in order.
   */
  async listBatch(
    targetGroupCode: string,
    afterSeq: bigint,
    limit = 500,
    startTime?: number,
    endTime?: number,
  ): Promise<GroupMsg[]> {
    const conditions: string[] = [`"40027" = ?`, `"40003" > ?`];
    const params: SqlValue[] = [targetGroupCode, afterSeq];
    if (startTime != null && startTime > 0) {
      conditions.push(`"40050" >= ?`);
      params.push(BigInt(startTime));
    }
    if (endTime != null && endTime > 0) {
      conditions.push(`"40050" <= ?`);
      params.push(BigInt(endTime));
    }
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE ${conditions.join(' AND ')}
        ORDER BY "40003" ASC
        LIMIT ?`,
      [...params, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /**
   * The page of **seq-less** messages (40003 = 0 / NULL) just newer than
   * `afterRowId` (exclusive), ordered by rowid ASC. Export-only: migration-
   * imported history lands with no per-group seq, so the normal `40003 > ?`
   * cursor never sees it. Those rows keep a real sendTime, so the export merges
   * this rowid-ordered stream (insertion order ≈ send-time order for an imported
   * block) against the seq stream by sendTime — see `message_source`. Restricting
   * to seq-less rows keeps the two streams disjoint (no dupes).
   */
  async listSeqlessAfterRowId(targetGroupCode: string, afterRowId: bigint, limit = 50): Promise<Array<GroupMsg & { rowId: bigint }>> {
    const rows = await this.qq.query(
      `SELECT rowid, ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ? AND rowid > ? AND ("40003" = 0 OR "40003" IS NULL)
        ORDER BY rowid ASC
        LIMIT ?`,
      [targetGroupCode, afterRowId, BigInt(limit)],
    );
    return rows.map(rowToGroupMsgWithRowId);
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

  /** Get raw msgBody (column 40800) by msgId. */
  async getMsgBody(msgId: bigint): Promise<Uint8Array | null> {
    const rows = await this.qq.query(`SELECT "40800" FROM group_msg_table WHERE "40001" = ? LIMIT 1`, [msgId]);
    return (rows[0]?.[0] as Uint8Array) ?? null;
  }

  /** Update the msgBody (column 40800) for a specific message. */
  async updateMsgBody(msgId: bigint, blob: Uint8Array): Promise<number> {
    return this.qq.write(`UPDATE group_msg_table SET "40800" = ? WHERE "40001" = ?`, [blob, msgId]);
  }

  /**
   * Read a message's type columns (40011 msgType / 40012 subType) by msgId, or
   * null if this table doesn't hold it. These are what QQ itself rewrites to
   * `(1,1)` when a message is recalled/deleted; WeQ's delete mirrors that (see
   * {@link writeMsgType}) and remembers the originals to restore them.
   */
  async readMsgType(msgId: bigint): Promise<{ msgType: bigint; subType: bigint } | null> {
    const rows = await this.qq.query(
      `SELECT "40011","40012" FROM group_msg_table WHERE "40001" = ? LIMIT 1`,
      [msgId],
    );
    const row = rows[0];
    if (!row) return null;
    return { msgType: toBigint(row[0]), subType: toBigint(row[1]) };
  }

  /**
   * Overwrite a message's type columns (40011/40012) in place. Delete writes
   * `(1,1)` — byte-identical to QQ's own recall — leaving the 40800 body intact
   * so the message still renders; restore writes the remembered originals back.
   */
  async writeMsgType(msgId: bigint, msgType: bigint, subType: bigint): Promise<number> {
    return this.qq.write(
      `UPDATE group_msg_table SET "40011" = ?, "40012" = ? WHERE "40001" = ?`,
      [msgType, subType, msgId],
    );
  }

  /**
   * Fetch full message rows by msgId (40001), newest-first. Used to render the
   * "deleted messages" list: WeQ's delete leaves rows in their normal partition
   * (only 40011/40012 change), so the deleted set is addressed by msgId, not a
   * hidden partition key. Empty input short-circuits to [].
   */
  async listByMsgIds(msgIds: bigint[]): Promise<GroupMsg[]> {
    if (msgIds.length === 0) return [];
    const placeholders = msgIds.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40001" IN (${placeholders})
        ORDER BY "40003" DESC`,
      msgIds,
    );
    return rows.map(rowToGroupMsg);
  }

  /**
   * All rows in one group carrying the `(1,1)` deleted signature (40011=1 &
   * 40012=1), newest-first. Covers BOTH WeQ's own deletes and QQ's native
   * recalls — the caller splits them by consulting the DeletedMsgStore. This is
   * what lets the "deleted messages" panel surface QQ recalls the store never
   * recorded. `limit` bounds a pathologically recall-heavy group.
   */
  async listDeletedByConv(targetGroupCode: string, limit = 200): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ? AND "40011" = 1 AND "40012" = 1
        ORDER BY "40003" DESC
        LIMIT ?`,
      [targetGroupCode, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /**
   * Append a new group message by cloning the group's newest row as a template
   * (see {@link appendClonedRow}). Returns the new msgId/msgSeq, or null if the
   * group has no message to clone.
   */
  async appendMessage(targetGroupCode: string, fields: AppendMsgFields): Promise<AppendMsgResult | null> {
    return appendClonedRow(this.qq, 'group_msg_table', '"40027" = ?', targetGroupCode, fields);
  }

  /**
   * Batch count messages per group. Returns { groupCode: count }.
   *
   * `opts` adds extra `AND`s onto the same indexed `40027 IN (…)` scan:
   *   - `startTime`/`endTime` (unix seconds) → window on `40050` sendTime;
   *   - `senderUid` → count only messages *this* uid sent (e.g. self, to rank
   *     「我在哪个群最活跃」 rather than the group's total traffic).
   */
  async countByGroups(
    groupCodes: string[],
    opts: { startTime?: number; endTime?: number; senderUid?: string } = {},
  ): Promise<Record<string, number>> {
    if (groupCodes.length === 0) return {};
    const placeholders = groupCodes.map(() => '?').join(',');
    const conditions = [`"40027" IN (${placeholders})`];
    const params: SqlValue[] = [...groupCodes];
    if (opts.startTime != null && opts.startTime > 0) {
      conditions.push(`"40050" >= ?`);
      params.push(BigInt(opts.startTime));
    }
    if (opts.endTime != null && opts.endTime > 0) {
      conditions.push(`"40050" <= ?`);
      params.push(BigInt(opts.endTime));
    }
    if (opts.senderUid) {
      conditions.push(`"40020" = ?`);
      params.push(opts.senderUid);
    }
    const rows = await this.qq.query(
      `SELECT "40027", COUNT(*) FROM group_msg_table WHERE ${conditions.join(' AND ')} GROUP BY "40027"`,
      params,
    );
    const result: Record<string, number> = {};
    for (const row of rows) {
      const code = String(row[0] ?? '');
      const count = typeof row[1] === 'bigint' ? Number(row[1]) : Number(row[1] ?? 0);
      if (code) result[code] = count;
    }
    return result;
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
    msgType: toBigint(row[8]),
    subType: toBigint(row[9]),
  };
}

/** As {@link rowToGroupMsg} but for a `SELECT rowid, …` row (indices shifted +1). */
function rowToGroupMsgWithRowId(row: SqlRow): GroupMsg & { rowId: bigint } {
  return {
    rowId: toBigint(row[0]),
    msgId: toBigint(row[1]),
    senderUid: toStr(row[2]),
    targetGroupCode: toStr(row[3]),
    senderUin: toBigint(row[4]),
    sendTime: toBigint(row[5]),
    elements: decodeBody(row[6]),
    setEmojiList: decodeEmoji(row[7]),
    msgSeq: toBigint(row[8]),
    msgType: toBigint(row[9]),
    subType: toBigint(row[10]),
  };
}

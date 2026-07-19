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
import { appendClonedRow, type AppendMsgFields, type AppendMsgResult } from './append';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40001","40020","40021","40030","40033","40050","40800","40003","40011","40012"`;

/**
 * Which partition column to filter a c2c conversation by. Prefer `sortNo`
 * (column 40027 — indexed); `uid` (column 40021 — unindexed) is the fallback
 * for peers missing from the uid map.
 */
export type C2cPartition = { sortNo: bigint } | { uid: string };

export function partitionWhere(part: C2cPartition): { clause: string; value: SqlValue } {
  return 'sortNo' in part
    ? { clause: '"40027" = ?', value: part.sortNo }
    : { clause: '"40021" = ?', value: part.uid };
}

export interface C2cMsgDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
  /**
   * Which table to read/write. Defaults to `c2c_msg_table`. `dataline_msg_table`
   * (cross-device sync — 我的手机/我的电脑) is structurally identical, so the same
   * class serves it verbatim; only the table name differs.
   */
  table?: string;
}

export class C2cMsgDb {
  private readonly qq: QqDb;
  private readonly table: string;

  constructor(nt: NtHelperBinding, opts: C2cMsgDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
    this.table = opts.table ?? 'c2c_msg_table';
  }

  /** Newest N messages in one conversation, newest-first (DESC by seq). */
  async listLatest(part: C2cPartition, limit = 50): Promise<C2cMsg[]> {
    const { clause, value } = partitionWhere(part);
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}
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
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}
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
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}
        WHERE ${clause} AND "40003" > ?
        ORDER BY "40003" ASC
        LIMIT ?`,
      [value, afterSeq, BigInt(limit)],
    );
    return rows.map(rowToC2cMsg);
  }

  /**
   * The page of **seq-less** messages (40003 = 0 / NULL) just newer than
   * `afterRowId` (exclusive), ordered by rowid ASC. Export-only: phone→PC
   * migrated history lands with no per-peer seq, so the normal `40003 > ?`
   * cursor never sees it. Those rows still carry a real sendTime, so the export
   * merges this rowid-ordered stream (insertion order ≈ send-time order for a
   * migrated block) against the seq stream by sendTime — see `message_source`.
   * Restricting to seq-less rows keeps the two streams disjoint (no dupes).
   */
  async listSeqlessAfterRowId(part: C2cPartition, afterRowId: bigint, limit = 50): Promise<Array<C2cMsg & { rowId: bigint }>> {
    const { clause, value } = partitionWhere(part);
    const rows = await this.qq.query(
      `SELECT rowid, ${SELECT_COLUMNS} FROM ${this.table}
        WHERE ${clause} AND rowid > ? AND ("40003" = 0 OR "40003" IS NULL)
        ORDER BY rowid ASC
        LIMIT ?`,
      [value, afterRowId, BigInt(limit)],
    );
    return rows.map(rowToC2cMsgWithRowId);
  }

  /**
   * Messages with seq >= `sinceSeq`, newest-first, capped at `limit`. The
   * "re-read the currently-loaded window" query — picks up new tail messages
   * plus in-place edits (recall) within the window.
   */
  async listFrom(part: C2cPartition, sinceSeq: bigint, limit = 500): Promise<C2cMsg[]> {
    const { clause, value } = partitionWhere(part);
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}
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
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}
        ORDER BY "40050" DESC
        LIMIT ? OFFSET ?`,
      [BigInt(limit), BigInt(offset)],
    );
    return rows.map(rowToC2cMsg);
  }

  /** Largest SQLite rowid currently in the table, or 0n if empty. */
  async latestRowId(): Promise<bigint> {
    const rows = await this.qq.query(`SELECT MAX(rowid) FROM ${this.table}`);
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
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}
        WHERE rowid > ?
        ORDER BY rowid ASC
        LIMIT ?`,
      [sinceRowId, BigInt(limit)],
    );
    return rows.map(rowToC2cMsg);
  }

  /** Get raw msgBody (column 40800) by msgId. */
  async getMsgBody(msgId: bigint): Promise<Uint8Array | null> {
    const rows = await this.qq.query(`SELECT "40800" FROM ${this.table} WHERE "40001" = ? LIMIT 1`, [msgId]);
    return (rows[0]?.[0] as Uint8Array) ?? null;
  }

  /**
   * Update the msgBody (column 40800) for a specific message.
   *
   * We ALSO bump 40002 (msgRandom) to a fresh value in the same UPDATE. This is
   * the "it's me, allow it" signal for the anti-recall trigger: QQ's own recall
   * rewrites 40800 while leaving 40002 untouched (proven in
   * test/compare_recall_40002.ts), so the trigger cancels any 40800/40900 change
   * that keeps 40002 the same. WeQ's legitimate edits change 40002, so they slip
   * past the trigger while QQ's recall is caught. Harmless when anti-recall is
   * off — 40002 is just a random tiebreaker column.
   */
  async updateMsgBody(msgId: bigint, blob: Uint8Array): Promise<number> {
    const newRandom = BigInt(Math.floor(Math.random() * 0x7fffffff));
    return this.qq.write(
      `UPDATE ${this.table} SET "40800" = ?, "40002" = ? WHERE "40001" = ?`,
      [blob, newRandom, msgId],
    );
  }

  /**
   * Read a message's type columns (40011 msgType / 40012 subType) by msgId, or
   * null if this table doesn't hold it. QQ itself rewrites these to `(1,1)` on
   * recall/delete; WeQ's delete mirrors that (see {@link writeMsgType}) and
   * remembers the originals to restore them.
   */
  async readMsgType(msgId: bigint): Promise<{ msgType: bigint; subType: bigint } | null> {
    const rows = await this.qq.query(
      `SELECT "40011","40012" FROM ${this.table} WHERE "40001" = ? LIMIT 1`,
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
      `UPDATE ${this.table} SET "40011" = ?, "40012" = ? WHERE "40001" = ?`,
      [msgType, subType, msgId],
    );
  }

  /**
   * Fetch full message rows by msgId (40001), newest-first. Used to render the
   * "deleted messages" list: WeQ's delete leaves rows in their normal partition
   * (only 40011/40012 change), so the deleted set is addressed by msgId, not a
   * hidden partition key. Empty input short-circuits to [].
   */
  async listByMsgIds(msgIds: bigint[]): Promise<C2cMsg[]> {
    if (msgIds.length === 0) return [];
    const placeholders = msgIds.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}
        WHERE "40001" IN (${placeholders})
        ORDER BY "40003" DESC`,
      msgIds,
    );
    return rows.map(rowToC2cMsg);
  }

  /**
   * All rows for one peer carrying the `(1,1)` deleted signature (40011=1 &
   * 40012=1), newest-first. Covers BOTH WeQ's own deletes and QQ's native
   * recalls — the caller splits them via the DeletedMsgStore. Lets the "deleted
   * messages" panel surface QQ recalls the store never recorded. `limit` bounds
   * a pathologically recall-heavy conversation.
   */
  async listDeletedByConv(targetUid: string, limit = 200): Promise<C2cMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}
        WHERE "40021" = ? AND "40011" = 1 AND "40012" = 1
        ORDER BY "40003" DESC
        LIMIT ?`,
      [targetUid, BigInt(limit)],
    );
    return rows.map(rowToC2cMsg);
  }

  /**
   * Append a new private-chat message by cloning the peer's newest row as a
   * template (see {@link appendClonedRow}). Returns the new msgId/msgSeq, or
   * null if the conversation has no message to clone.
   */
  async appendMessage(part: C2cPartition, fields: AppendMsgFields): Promise<AppendMsgResult | null> {
    const { clause, value } = partitionWhere(part);
    return appendClonedRow(this.qq, this.table, clause, value, fields);
  }

  /**
   * Batch count messages per peer by uid. Returns { uid: count }.
   *
   * `opts` narrows the count without changing the (indexed) `40021 IN (…)`
   * grouping — every filter is an extra `AND` on the same scan:
   *   - `startTime`/`endTime` (unix seconds) → window on `40050` sendTime;
   *   - `senderUid` → count only messages *this* uid sent (e.g. self, to get
   *     「我发了多少」 rather than the conversation total).
   */
  async countByUids(
    uids: string[],
    opts: { startTime?: number; endTime?: number; senderUid?: string } = {},
  ): Promise<Record<string, number>> {
    if (uids.length === 0) return {};
    const placeholders = uids.map(() => '?').join(',');
    const conditions = [`"40021" IN (${placeholders})`];
    const params: SqlValue[] = [...uids];
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
      `SELECT "40021", COUNT(*) FROM ${this.table} WHERE ${conditions.join(' AND ')} GROUP BY "40021"`,
      params,
    );
    const result: Record<string, number> = {};
    for (const row of rows) {
      const uid = String(row[0] ?? '');
      const count = typeof row[1] === 'bigint' ? Number(row[1]) : Number(row[1] ?? 0);
      if (uid) result[uid] = count;
    }
    return result;
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
    msgType: toBigint(row[8]),
    subType: toBigint(row[9]),
  };
}

/** As {@link rowToC2cMsg} but for a `SELECT rowid, …` row (indices shifted +1). */
function rowToC2cMsgWithRowId(row: SqlRow): C2cMsg & { rowId: bigint } {
  return {
    rowId: toBigint(row[0]),
    msgId: toBigint(row[1]),
    senderUid: toStr(row[2]),
    targetUid: toStr(row[3]),
    targetUin: toBigint(row[4]),
    senderUin: toBigint(row[5]),
    sendTime: toBigint(row[6]),
    elements: decodeBody(row[7]),
    msgSeq: toBigint(row[8]),
    msgType: toBigint(row[9]),
    subType: toBigint(row[10]),
  };
}

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
import type { C2cMsg, SeqWindow } from './types';
import { decodeBody, decodeDress, toBigint, toStr } from './util';
import { appendClonedRow, type AppendMsgFields, type AppendMsgResult } from './append';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40001","40020","40021","40030","40033","40050","40800","40003","40011","40012","40801"`;

/**
 * Conversation ordering. 40003 alone is NOT a total order: gray tips share the
 * seq of the message they hang off, so a same-seq run's order fell to whatever
 * index SQLite happened to walk. Sending time then msgId settle it, and keeping
 * 40003 first still hits the `(40027,40003)` index.
 */
const ORDER_NEWEST_FIRST = `ORDER BY "40003" DESC, "40050" DESC, "40001" DESC`;
const ORDER_OLDEST_FIRST = `ORDER BY "40003" ASC, "40050" ASC, "40001" ASC`;

/**
 * Which partition column to filter a c2c conversation by. Prefer `sortNo`
 * (column 40027 — indexed); `uid` (column 40021 — unindexed) is the fallback
 * for peers missing from the uid map. `appId` (column 40035) is for
 * `service_assistant_msg_table` reuse — that table has no per-peer uid (40020/
 * 40021 are both always the account's own uid), so its conversations partition
 * by the numeric service/app id instead.
 */
export type C2cPartition = { sortNo: bigint } | { uid: string } | { appId: bigint };

export function partitionWhere(part: C2cPartition): { clause: string; value: SqlValue } {
  if ('sortNo' in part) return { clause: '"40027" = ?', value: part.sortNo };
  if ('appId' in part) return { clause: '"40035" = ?', value: part.appId };
  return { clause: '"40021" = ?', value: part.uid };
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
        ${ORDER_NEWEST_FIRST}
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
        ${ORDER_NEWEST_FIRST}
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
        ${ORDER_OLDEST_FIRST}
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
  async listSeqlessAfterRowId(
    part: C2cPartition,
    afterRowId: bigint,
    limit = 50,
  ): Promise<Array<C2cMsg & { rowId: bigint }>> {
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
        ${ORDER_NEWEST_FIRST}
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

  /**
   * The conversation's seq window for a time range (40003 > 0), newest-first.
   * Powers the export 「消息补全」seq 空窗扫描.
   *
   * No time bounds keeps the original index-only DISTINCT scan over the
   * `(40027,40003)` composite index. With `startTime`/`endTime` (unix seconds)
   * it reads each row's 40050 once and returns only the seqs inside the
   * window, plus the boundary anchors `below` (newest seq older than
   * `startTime`) and `above` (oldest seq newer than `endTime`) — the caller
   * clamps its bottom gap with them so a narrow window doesn't pull the whole
   * pre-window history.
   */
  async listSeqDesc(
    part: C2cPartition,
    opts: { startTime?: number; endTime?: number } = {},
  ): Promise<SeqWindow> {
    const { clause, value } = partitionWhere(part);
    const { startTime, endTime } = opts;
    if (startTime == null && endTime == null) {
      const rows = await this.qq.query(
        `SELECT DISTINCT "40003" FROM ${this.table}
          WHERE ${clause} AND "40003" > 0
          ORDER BY "40003" DESC`,
        [value],
      );
      return { seqs: rows.map((row) => toBigint(row[0])), below: null, above: null };
    }
    const rows = await this.qq.query(
      `SELECT "40003", "40050" FROM ${this.table}
        WHERE ${clause} AND "40003" > 0
        ORDER BY "40003" DESC`,
      [value],
    );
    const seqs: bigint[] = [];
    let below: bigint | null = null;
    let above: bigint | null = null;
    for (const row of rows) {
      const seq = toBigint(row[0]);
      const time = Number(row[1]);
      if (startTime != null && time < startTime) {
        below ??= seq; // 新→旧扫描：首个（最新）早于窗的消息即 below。
        continue;
      }
      if (endTime != null && time > endTime) {
        above = seq; // 覆盖式赋值：最后一个（最旧）晚于窗的消息即 above。
        continue;
      }
      seqs.push(seq);
    }
    return { seqs, below, above };
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
    const rows = await this.qq.query(
      `SELECT "40800" FROM ${this.table} WHERE "40001" = ? LIMIT 1`,
      [msgId],
    );
    return (rows[0]?.[0] as Uint8Array) ?? null;
  }

  /** Get raw decoration blob (column 40801) by msgId. */
  async getMsgDressBlob(msgId: bigint): Promise<Uint8Array | null> {
    const rows = await this.qq.query(
      `SELECT "40801" FROM ${this.table} WHERE "40001" = ? LIMIT 1`,
      [msgId],
    );
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
    return this.qq.write(`UPDATE ${this.table} SET "40800" = ?, "40002" = ? WHERE "40001" = ?`, [
      blob,
      newRandom,
      msgId,
    ]);
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
    return this.qq.write(`UPDATE ${this.table} SET "40011" = ?, "40012" = ? WHERE "40001" = ?`, [
      msgType,
      subType,
      msgId,
    ]);
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
        ${ORDER_NEWEST_FIRST}`,
      msgIds,
    );
    return rows.map(rowToC2cMsg);
  }

  /**
   * Fetch full rows by msgSeq (40003) within ONE partition (40027), so the
   * query hits the (40027,40003) composite index. Used to resolve FTS search
   * hits back to their original 40800 bodies: the FTS rows carry the same
   * 40027 partition + 40003 seq, so the join never leaves the partition.
   * Empty input short-circuits to [].
   */
  async listBySeqsInPartition(part: C2cPartition, seqs: bigint[]): Promise<C2cMsg[]> {
    if (seqs.length === 0) return [];
    const { clause, value } = partitionWhere(part);
    const placeholders = seqs.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}
        WHERE ${clause} AND "40003" IN (${placeholders})
        ${ORDER_NEWEST_FIRST}`,
      [value, ...seqs],
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
        ${ORDER_NEWEST_FIRST}
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
  async appendMessage(
    part: C2cPartition,
    fields: AppendMsgFields,
  ): Promise<AppendMsgResult | null> {
    const { clause, value } = partitionWhere(part);
    return appendClonedRow(this.qq, this.table, clause, value, fields);
  }

  /**
   * Oldest sendTime (column 40050, unix seconds) in the whole table, or null
   * when empty. Unindexed — a single-pass MIN scan; used once per report open
   * to derive the first available year, then cached by the caller.
   */
  async oldestSendTime(): Promise<bigint | null> {
    const rows = await this.qq.query(`SELECT MIN("40050") FROM ${this.table} WHERE "40050" > 0`);
    const value = rows[0]?.[0];
    return value == null ? null : toBigint(value);
  }

  /**
   * Infer the account's own uin from the data itself, in ONE pass: in
   * `c2c_msg_table` column 40021 (targetUid) is always the peer, and the rows
   * we sent are exactly the ones whose 40020 (senderUid) differs from the
   * peer. So the most common 40033 among those rows is our own uin — fully
   * independent of profile_info / session identity, and always consistent with
   * the database being scanned. This is the correct uin to feed the group
   * direction count, whose 40033 carries real senders. Returns null when there
   * is no evidence (no sent rows at all).
   */
  async inferSelfUin(): Promise<bigint | null> {
    const rows = await this.qq.query(
      `SELECT "40033", COUNT(*) AS n FROM ${this.table}
       WHERE "40020" != "40021" AND "40020" != '' AND "40033" > 0
       GROUP BY "40033" ORDER BY n DESC LIMIT 1`,
    );
    const value = rows[0]?.[0];
    return value == null ? null : toBigint(value);
  }

  /**
   * Split the whole table's rows in a time window into sent / received, in ONE
   * pass. Direction comes from the data itself — no external identity needed:
   * 40021 (targetUid) is always the peer, so `senderUid != targetUid` marks a
   * row as sent (QQ writes the peer into both columns for incoming rows). Rows
   * with an empty senderUid are malformed edge cases and never count as sent.
   * Excludes dataline / service tables — callers pass the exact C2cMsgDb
   * instance they want (c2c = private chats only).
   */
  async countByDirection(
    opts: { startTime?: number; endTime?: number } = {},
  ): Promise<{ sent: number; received: number }> {
    const conditions: string[] = [];
    const params: SqlValue[] = [];
    if (opts.startTime != null && opts.startTime > 0) {
      conditions.push(`"40050" >= ?`);
      params.push(BigInt(opts.startTime));
    }
    if (opts.endTime != null && opts.endTime > 0) {
      conditions.push(`"40050" < ?`);
      params.push(BigInt(opts.endTime));
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.qq.query(
      `SELECT CASE WHEN "40020" != "40021" AND "40020" != '' THEN 1 ELSE 0 END AS mine, COUNT(*) AS n
       FROM ${this.table}${where}
       GROUP BY 1`,
      params,
    );
    let sent = 0;
    let received = 0;
    for (const row of rows) {
      const mine = Number(row[0] ?? 0);
      const n = Number(row[1] ?? 0);
      if (mine === 1) sent = n;
      else received = n;
    }
    return { sent, received };
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
    decoration: decodeDress(row[10]),
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

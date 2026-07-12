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

const SELECT_COLUMNS = `"40001","40020","40021","40030","40033","40050","40800","40003"`;

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

  /** Update the msgBody (column 40800) for a specific message. */
  async updateMsgBody(msgId: bigint, blob: Uint8Array): Promise<number> {
    return this.qq.write(`UPDATE ${this.table} SET "40800" = ? WHERE "40001" = ?`, [blob, msgId]);
  }

  /**
   * Reversible soft-delete: hide a message from its conversation without
   * dropping the row. XOR `mask` (a high bit, far above any real sortNo) into
   * the indexed partition key 40027 so the fast-path query `WHERE "40027" =
   * sortNo` no longer matches, AND prefix the TEXT key 40021 with `uidPrefix`
   * so the uid-fallback / dataline query `WHERE "40021" = uid` misses it too.
   * The `("40027" & mask) = 0` guard makes it idempotent. Returns affected rows.
   */
  async softDelete(msgId: bigint, mask: bigint, uidPrefix: string): Promise<number> {
    return this.qq.write(
      // SQLite has no `^` (XOR) operator; use the identity a^b = (a|b) - (a&b).
      `UPDATE ${this.table}
          SET "40027" = ("40027" | ?) - ("40027" & ?), "40021" = ? || "40021"
        WHERE "40001" = ? AND ("40027" & ?) = 0`,
      [mask, mask, uidPrefix, msgId, mask],
    );
  }

  /**
   * List the soft-deleted messages of one peer, newest-first. A {@link softDelete}
   * always prefixes the TEXT key 40021 with `uidPrefix` (on both the c2c and
   * dataline tables), so a single equality on the prefixed uid finds exactly the
   * rows hidden from this conversation — the mask bit on 40027 is left implicit.
   * Returns them shaped like any other page (seq 40003 is untouched by delete).
   */
  async listDeleted(uid: string, uidPrefix: string, limit = 200): Promise<C2cMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM ${this.table}
        WHERE "40021" = ?
        ORDER BY "40003" DESC
        LIMIT ?`,
      [uidPrefix + uid, BigInt(limit)],
    );
    return rows.map(rowToC2cMsg);
  }

  /** Reverse {@link softDelete}: XOR 40027 back and strip the 40021 prefix. */
  async restore(msgId: bigint, mask: bigint, uidPrefix: string): Promise<number> {
    return this.qq.write(
      // SQLite has no `^` (XOR) operator; use the identity a^b = (a|b) - (a&b).
      `UPDATE ${this.table}
          SET "40027" = ("40027" | ?) - ("40027" & ?),
              "40021" = CASE WHEN "40021" LIKE ? THEN SUBSTR("40021", ?) ELSE "40021" END
        WHERE "40001" = ? AND ("40027" & ?) <> 0`,
      [mask, mask, uidPrefix + '%', BigInt(uidPrefix.length + 1), msgId, mask],
    );
  }

  /**
   * Hard-delete: physically drop the row (by msgId 40001) from this table. Unlike
   * {@link softDelete} this is irreversible — the message is gone, not hidden.
   * Returns affected rows (0 if this table doesn't hold the msgId).
   */
  async hardDelete(msgId: bigint): Promise<number> {
    return this.qq.write(`DELETE FROM ${this.table} WHERE "40001" = ?`, [msgId]);
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

  /** Batch count messages per peer by uid. Returns { uid: count }. */
  async countByUids(uids: string[]): Promise<Record<string, number>> {
    if (uids.length === 0) return {};
    const placeholders = uids.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT "40021", COUNT(*) FROM ${this.table} WHERE "40021" IN (${placeholders}) GROUP BY "40021"`,
      uids,
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
  };
}

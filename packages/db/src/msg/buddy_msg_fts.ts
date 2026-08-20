/**
 * `buddy_msg_fts` — QQ's full-text-search content table for message text.
 *
 * `buddy_msg_fts.db` actually holds two things:
 *   - `buddy_msg_fts`      — a plain content table with the flattened message
 *                            text + identity keys (what we read here).
 *   - `buddy_msg_fts_fts`  — an FTS5 virtual table over it, declared with
 *                            `tokenize = 'pinyin_letter 0'`.
 *
 * We CAN'T use the FTS5 table: `pinyin_letter` is QQ's own tokenizer, not
 * registered in our SQLCipher build, so any query against `buddy_msg_fts_fts`
 * dies with `no such tokenizer: pinyin_letter`. Instead we search the content
 * table directly with `LIKE` (substring match — robust, tokenizer-free) and
 * rank candidates by a relevance heuristic in JS to surface the best matches.
 *
 * Column map (subset we read):
 *   40001  msgId      (INTEGER UNIQUE — joins back to c2c/group msg tables)
 *   40010  chatType   (ChatType: 1 = c2c, 2 = group, …)
 *   40020  senderUid  (sender)
 *   40021  targetUid  (conversation target — peer uid; app-facing key, UNINDEXED)
 *   40027  sortNo     (INTEGER — per-account peer index; same value as
 *                      c2c_msg_table.40027, and the *indexed* conversation key)
 *   40050  sendTime   (INTEGER, unix seconds — used to order the candidate pool)
 *   41701  content    (the searchable flattened text)
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';
import type { BuddyMsgFtsHit } from './types';
import { toBigint, toStr } from './util';
import { partitionWhere, type C2cPartition } from './c2c';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40001","40010","40021","40020","41701","40050","41702","40003"`;

/**
 * How many newest LIKE-matching rows to pull before ranking. We over-fetch
 * (relative to `limit`) so the relevance heuristic has room to reorder, then
 * trim to `limit`. Capped so a hot keyword can't drag the whole table in.
 */
const POOL_FACTOR = 20;
const MIN_POOL = 100;
const MAX_POOL = 500;

export interface BuddyMsgFtsDbOptions {
  /** Absolute path to buddy_msg_fts.db. */
  dbPath: string;
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

export class BuddyMsgFtsDb {
  /** Encrypted source path (mirrors QqDb.dbPath). */
  readonly dbPath: string;
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: BuddyMsgFtsDbOptions) {
    this.dbPath = opts.dbPath;
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * Search messages whose text or filename contains `keyword`, best matches first.
   */
  async search(keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    const needle = keyword.trim();
    if (!needle) return [];

    const poolSize = Math.min(MAX_POOL, Math.max(limit * POOL_FACTOR, MIN_POOL));
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM buddy_msg_fts
        WHERE ("41701" LIKE ? ESCAPE '\\' OR "41702" LIKE ? ESCAPE '\\')
        ORDER BY "40050" DESC
        LIMIT ?`,
      [`%${escapeLike(needle)}%`, `%${escapeLike(needle)}%`, BigInt(poolSize)],
    );

    const hits = rows.map(rowToHit);
    return rankByRelevance(hits, needle).slice(0, limit);
  }

  /**
   * Search messages within a specific c2c conversation. Filters by the indexed
   * partition column `40027` (sortNo) on the fast path; `40021` (uid) is
   * unindexed and only used as a fallback for peers missing from the uid map.
   * Callers resolve uid → sortNo via the session's `UidMap` (see MsgSearchService).
   */
  async searchInConversation(
    part: C2cPartition,
    keyword: string,
    limit = 20,
  ): Promise<BuddyMsgFtsHit[]> {
    const needle = keyword.trim();
    if (!needle) return [];

    const { clause, value } = partitionWhere(part);
    const poolSize = Math.min(MAX_POOL, Math.max(limit * POOL_FACTOR, MIN_POOL));
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM buddy_msg_fts
        WHERE ${clause} AND ("41701" LIKE ? ESCAPE '\\' OR "41702" LIKE ? ESCAPE '\\')
        ORDER BY "40050" DESC
        LIMIT ?`,
      [value, `%${escapeLike(needle)}%`, `%${escapeLike(needle)}%`, BigInt(poolSize)],
    );

    const hits = rows.map(rowToHit);
    return rankByRelevance(hits, needle).slice(0, limit);
  }

  /**
   * Search only by filename.
   */
  async searchFiles(keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    const needle = keyword.trim();
    if (!needle) return [];

    const poolSize = Math.min(MAX_POOL, Math.max(limit * POOL_FACTOR, MIN_POOL));
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM buddy_msg_fts
        WHERE "41702" LIKE ? ESCAPE '\\'
        ORDER BY "40050" DESC
        LIMIT ?`,
      [`%${escapeLike(needle)}%`, BigInt(poolSize)],
    );

    const hits = rows.map(rowToHit);
    return rankByRelevance(hits, needle).slice(0, limit);
  }

  /**
   * Top conversations by match count for `keyword` (text column 41701 only),
   * most matches first. GROUP BY the indexed 40027 partition — buddy partition
   * is the peer sortNo; callers translate it back to a uid via the UidMap.
   */
  async topConversationsByKeyword(
    keyword: string,
    limit = 20,
  ): Promise<Array<{ partition: bigint; count: number }>> {
    const needle = keyword.trim();
    if (!needle) return [];
    // Bounded inner scan: the GROUP BY/sort only sees the first 200k matching
    // rows, so a hot keyword can't hash 1.5M rows. Counts for very common
    // keywords are approximate but the top conversations stay correct enough.
    const rows = await this.qq.query(
      `SELECT "40027", COUNT(*) FROM (
        SELECT "40027" FROM buddy_msg_fts
          WHERE "41701" LIKE ? ESCAPE '\\'
          LIMIT 200000
      ) GROUP BY "40027"
        ORDER BY COUNT(*) DESC
        LIMIT ?`,
      [`%${escapeLike(needle)}%`, BigInt(limit)],
    );
    return rows.map((row) => ({
      partition: toBigint(row[0]),
      count: Number(row[1] ?? 0),
    }));
  }

  /**
   * Paginated messages of ONE conversation (40027 partition) matching `keyword`
   * in the text column (41701). Uses the 40027 index to narrow the scan to the
   * conversation before applying LIKE. Newest first. Used by the chat-record
   * modal right panel; `total` counts every matching message.
   */
  async searchInPartition(
    partition: bigint,
    keyword: string,
    limit = 20,
    offset = 0,
  ): Promise<{ items: BuddyMsgFtsHit[]; total: number }> {
    const needle = keyword.trim();
    if (!needle) return { items: [], total: 0 };
    const like = `%${escapeLike(needle)}%`;
    const [countRows, rows] = await Promise.all([
      this.qq.query(
        `SELECT COUNT(*) FROM buddy_msg_fts
          WHERE "40027" = ? AND "41701" LIKE ? ESCAPE '\\'`,
        [partition, like],
      ),
      this.qq.query(
        `SELECT ${SELECT_COLUMNS} FROM buddy_msg_fts
          WHERE "40027" = ? AND "41701" LIKE ? ESCAPE '\\'
          ORDER BY "40050" DESC
          LIMIT ? OFFSET ?`,
        [partition, like, BigInt(limit), BigInt(offset)],
      ),
    ]);
    return {
      items: rows.map(rowToHit),
      total: Number(countRows[0]?.[0] ?? 0),
    };
  }

  /**
   * Paginated files (filename column 41702) matching `keyword`, newest first.
   * `total` counts every matching file row for the "more" modal.
   */
  async searchFilesByKeyword(
    keyword: string,
    limit = 20,
    offset = 0,
  ): Promise<{ items: BuddyMsgFtsHit[]; total: number }> {
    const needle = keyword.trim();
    if (!needle) return { items: [], total: 0 };
    const like = `%${escapeLike(needle)}%`;
    const [countRows, rows] = await Promise.all([
      this.qq.query(`SELECT COUNT(*) FROM buddy_msg_fts WHERE "41702" LIKE ? ESCAPE '\\'`, [like]),
      this.qq.query(
        `SELECT ${SELECT_COLUMNS} FROM buddy_msg_fts
          WHERE "41702" LIKE ? ESCAPE '\\'
          ORDER BY "40050" DESC
          LIMIT ? OFFSET ?`,
        [like, BigInt(limit), BigInt(offset)],
      ),
    ]);
    return {
      items: rows.map(rowToHit),
      total: Number(countRows[0]?.[0] ?? 0),
    };
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}

/** Escape SQLite `LIKE` wildcards so a literal `%`/`_`/`\` in the keyword matches itself. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Rank hits best-first. The score rewards, in priority order:
 *   - exact match (the whole message IS the keyword),
 *   - higher keyword density (keyword占比 of the text),
 *   - more occurrences,
 *   - earlier first position.
 * Ties keep the incoming order (newest first), since `Array.sort` is stable.
 */
function rankByRelevance(hits: BuddyMsgFtsHit[], needle: string): BuddyMsgFtsHit[] {
  return hits
    .map((hit) => ({ hit, score: scoreOfMultiple(hit.content, hit.fileName || '', needle) }))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.hit);
}

function scoreOfMultiple(content: string, fileName: string, needle: string): number {
  return Math.max(scoreOf(content, needle), scoreOf(fileName, needle));
}

function scoreOf(text: string, needle: string): number {
  if (!text) return 0;
  let count = 0;
  let idx = text.indexOf(needle);
  const firstPos = idx;
  while (idx !== -1) {
    count++;
    idx = text.indexOf(needle, idx + needle.length);
  }
  if (count === 0) return 0;

  const exact = text.trim() === needle ? 1_000_000 : 0;
  const density = (count * needle.length) / Math.max(text.length, 1); // 0..1
  const posBonus = 1 / (1 + firstPos);
  return exact + density * 1000 + count * 10 + posBonus;
}

function rowToHit(row: SqlRow): BuddyMsgFtsHit {
  return {
    msgId: toBigint(row[0]),
    chatType: Number(toBigint(row[1])),
    targetUid: toStr(row[2]),
    senderUid: toStr(row[3]),
    content: toStr(row[4]),
    sendTime: toBigint(row[5]),
    fileName: toStr(row[6]),
    msgSeq: toBigint(row[7]),
  };
}

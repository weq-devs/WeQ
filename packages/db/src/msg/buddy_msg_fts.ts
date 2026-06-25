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
 *   40021  targetUid  (conversation target — peer uid / group code)
 *   40050  sendTime   (INTEGER, unix seconds — used to order the candidate pool)
 *   41701  content    (the searchable flattened text)
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';
import type { BuddyMsgFtsHit } from './types';
import { toBigint, toStr } from './util';
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
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: BuddyMsgFtsDbOptions) {
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
   * Search messages within a specific conversation.
   */
  async searchInConversation(targetUid: string, keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    const needle = keyword.trim();
    if (!needle) return [];

    const poolSize = Math.min(MAX_POOL, Math.max(limit * POOL_FACTOR, MIN_POOL));
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM buddy_msg_fts
        WHERE "40021" = ? AND ("41701" LIKE ? ESCAPE '\\' OR "41702" LIKE ? ESCAPE '\\')
        ORDER BY "40050" DESC
        LIMIT ?`,
      [targetUid, `%${escapeLike(needle)}%`, `%${escapeLike(needle)}%`, BigInt(poolSize)],
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

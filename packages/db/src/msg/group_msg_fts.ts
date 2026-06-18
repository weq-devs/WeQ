/**
 * `group_msg_fts` — QQ's full-text-search content table for group message text.
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';
import type { BuddyMsgFtsHit } from './types';
import { toBigint, toStr } from './util';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40001","40010","40021","40020","41701","40050","41702","40003"`;

const POOL_FACTOR = 20;
const MIN_POOL = 100;
const MAX_POOL = 500;

export interface GroupMsgFtsDbOptions {
  /** Absolute path to group_msg_fts.db. */
  dbPath: string;
  /** SQLCipher key. */
  key: string;
  /** Database algorithms. */
  algo: DatabaseAlgorithms;
}

export class GroupMsgFtsDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GroupMsgFtsDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * Search group messages whose text or filename contains `keyword`, best matches first.
   */
  async search(keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    const needle = keyword.trim();
    if (!needle) return [];

    const poolSize = Math.min(MAX_POOL, Math.max(limit * POOL_FACTOR, MIN_POOL));
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_fts
        WHERE ("41701" LIKE ? ESCAPE '\\' OR "41702" LIKE ? ESCAPE '\\')
        ORDER BY "40050" DESC
        LIMIT ?`,
      [`%${escapeLike(needle)}%`, `%${escapeLike(needle)}%`, BigInt(poolSize)],
    );

    const hits = rows.map(rowToHit);
    return rankByRelevance(hits, needle).slice(0, limit);
  }

  /**
   * Search messages within a specific group.
   */
  async searchInGroup(groupCode: string, keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    const needle = keyword.trim();
    if (!needle) return [];

    const poolSize = Math.min(MAX_POOL, Math.max(limit * POOL_FACTOR, MIN_POOL));
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_fts
        WHERE "40021" = ? AND ("41701" LIKE ? ESCAPE '\\' OR "41702" LIKE ? ESCAPE '\\')
        ORDER BY "40050" DESC
        LIMIT ?`,
      [groupCode, `%${escapeLike(needle)}%`, `%${escapeLike(needle)}%`, BigInt(poolSize)],
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
      `SELECT ${SELECT_COLUMNS} FROM group_msg_fts
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

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

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

/**
 * `recent_contact_top_table` — the pinned (置顶) conversations.
 *
 * Column map (the whole table — it only has 5 columns):
 *   41145  id        (INTEGER, pk — a 64-bit row id, not a conversation id)
 *   40010  chatType  (INTEGER → mapped ChatType, same enum as recent_contact)
 *   41103  topTime   (INTEGER, unix seconds — when the pin was applied)
 *   1000   peerUid   (TEXT — c2c peer uid; NULL on group rows)
 *   60001  groupCode (INTEGER — group code; NULL on c2c rows)
 *
 * The table is a pure pin registry: no name/preview/time-of-last-message. It's
 * joined against `recent_contact_v3_table` by `targetId` on the consumer side.
 */

import { enumName, ChatType } from '@weq/codec';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { RecentContactTop } from './types';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"41145","40010","41103","1000","60001"`;

export interface RecentContactTopDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

export class RecentContactTopDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: RecentContactTopDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * Every pinned conversation, most recently pinned first. QQ caps the pin
   * count at a handful, so there's no limit/paging.
   */
  async getTopContacts(): Promise<RecentContactTop[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM recent_contact_top_table ORDER BY "41103" DESC`,
    );
    return rows.map(rowToTopContact);
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}

// ---------- row → RecentContactTop ---------------------------------------

function rowToTopContact(row: SqlRow): RecentContactTop {
  const peerUid = toStr(row[3]);
  const groupCode = toBigint(row[4]);
  return {
    id: toBigint(row[0]),
    chatType: enumName(ChatType, toNum(row[1])),
    topTime: toBigint(row[2]),
    peerUid,
    groupCode,
    targetId: peerUid || (groupCode === 0n ? '' : groupCode.toString()),
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

function toNum(v: SqlValue | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toStr(v: SqlValue | undefined): string {
  return typeof v === 'string' ? v : '';
}

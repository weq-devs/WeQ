/**
 * `recent_contact_delete_storage` — deleted (「删除的会话」) conversations.
 *
 * Column map:
 *   1005   sessionKey   (TEXT — format: "{chatType}_{uid}" where chatType is numeric,
 *                         uid is the peer uid for c2c or group code for groups)
 *   40050  sendTime     (INTEGER — last message time, unix seconds)
 *   49740  deleteTime   (INTEGER — deletion timestamp, unix milliseconds)
 *
 * Key difference from hidden sessions: deleted sessions are REMOVED from
 * `recent_contact_v3_table` entirely, so they don't appear in the main list
 * automatically. We only show them via a pinned merged session entry.
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { DeletedSession } from './types';
import { QqDb } from '../qq_db';

export interface DeletedSessionDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

export class DeletedSessionDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: DeletedSessionDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** All deleted sessions. The table may hold dozens of rows. */
  async listDeletedSessions(): Promise<DeletedSession[]> {
    const rows = await this.qq.query(`SELECT "1005","40050","49740" FROM recent_contact_delete_storage`);
    return rows.map(rowToDeletedSession).filter((s): s is DeletedSession => s !== null);
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}

function rowToDeletedSession(row: SqlRow): DeletedSession | null {
  const sessionKey = toStr(row[0]);
  const sendTime = toBigInt(row[1]);
  const deleteTime = toBigInt(row[2]);

  // Parse sessionKey: "{chatType}_{uid}"
  const parts = sessionKey.split('_');
  if (parts.length < 2) {
    console.warn('[DeletedSessionDb] malformed sessionKey:', sessionKey);
    return null;
  }

  const chatTypeStr = parts[0];
  const targetUid = parts.slice(1).join('_'); // rejoin in case uid contains underscores

  if (!targetUid || !chatTypeStr) {
    return null;
  }

  const chatType = Number(chatTypeStr);
  if (!Number.isFinite(chatType)) {
    console.warn('[DeletedSessionDb] non-numeric chatType in sessionKey:', sessionKey);
    return null;
  }

  return {
    sessionKey,
    chatType,
    targetUid,
    sendTime,
    deleteTime,
  };
}

function toStr(v: SqlValue | undefined): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

function toBigInt(v: SqlValue | undefined): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') {
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

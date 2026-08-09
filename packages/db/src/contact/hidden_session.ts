/**
 * `hidden_session_storage_table_v1` — hidden (「隐藏聊天」) conversations.
 *
 * Column map:
 *   43001  storageKey  (TEXT, PRIMARY KEY — opaque; observed formats differ
 *                        between rows and shouldn't be parsed for meaning)
 *   43002  entry       (BLOB — protobuf {43002: HiddenSessionEntry}, see
 *                        `@weq/codec/proto/msg/43002`)
 *
 * Reverse-engineered from a real android backup (only 3 rows total — small
 * sample, kept conservative). See `HiddenSessionEntry` in the proto file for
 * the field-by-field notes.
 */

import { ProtoMsg, enumName, ChatType } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { HiddenSessionBody } from '@weq/codec/proto/msg/43002';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { HiddenSession } from './types';
import { QqDb } from '../qq_db';

const bodyCodec = new ProtoMsg(HiddenSessionBody);

export interface HiddenSessionDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

export class HiddenSessionDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: HiddenSessionDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** All hidden sessions. The table only ever holds a handful of rows. */
  async listHiddenSessions(): Promise<HiddenSession[]> {
    const rows = await this.qq.query(`SELECT "43001","43002" FROM hidden_session_storage_table_v1`);
    return rows.map(rowToHiddenSession);
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}

function rowToHiddenSession(row: SqlRow): HiddenSession {
  const entry = decodeEntry(row[1]);
  return {
    storageKey: toStr(row[0]),
    chatType: entry?.chatType != null ? enumName(ChatType, entry.chatType) : 'unknown',
    targetUid: entry?.targetUid ?? '',
    targetUin: entry?.targetUin ?? '',
    flags: {
      f49702: !!entry?.flag49702,
      f49703: !!entry?.flag49703,
      f49704: !!entry?.flag49704,
      f49705: !!entry?.flag49705,
    },
  };
}

function decodeEntry(blob: SqlValue | undefined) {
  if (!(blob instanceof Uint8Array)) return null;
  try {
    const decoded = bodyCodec.decode(sanitizeBytes(blob, HiddenSessionBody));
    return decoded.entry ?? null;
  } catch (e) {
    console.error('[HiddenSessionDb] failed to decode 43002 body:', e);
    return null;
  }
}

function toStr(v: SqlValue | undefined): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

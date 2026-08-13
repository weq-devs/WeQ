/**
 * `service_assistant_contact` — QQ 服务号 (chatType 118) contact list.
 *
 * Column map (the whole table):
 *   40001  lastMsgId    (INTEGER — matches a row in service_assistant_msg_table)
 *   40050  lastTime     (INTEGER, unix seconds)
 *   40051  preview      (BLOB — not decoded here; callers resolve the real
 *                         preview by querying service_assistant_msg_table
 *                         directly, same as HiddenSessionDb does)
 *   40094  displayName  (TEXT)
 *   41102  appId        (INTEGER, PRIMARY KEY — the conversation key, matches
 *                         service_assistant_msg_table's 40035)
 *   41110  avatarUrl    (TEXT — a direct CDN URL, not uid-derived)
 *   41131  unknown      (BLOB — small, meaning not pinned down; not read)
 *
 * Reverse-engineered from a real android backup (2 rows total). Distinct from
 * `recent_contact_v3_table`: 118 rows never appear there.
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { ServiceAssistantContact } from './types';
import { QqDb } from '../qq_db';

export interface ServiceAssistantContactDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

export class ServiceAssistantContactDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: ServiceAssistantContactDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** All 服务号 contacts. The table only ever holds a handful of rows. */
  async listContacts(): Promise<ServiceAssistantContact[]> {
    const rows = await this.qq.query(
      `SELECT "41102","40094","41110","40050","40001" FROM service_assistant_contact`,
    );
    return rows.map(rowToServiceAssistantContact);
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}

function rowToServiceAssistantContact(row: SqlRow): ServiceAssistantContact {
  return {
    appId: toBigint(row[0]),
    displayName: toStr(row[1]),
    avatarUrl: toStr(row[2]),
    lastTime: toBigint(row[3]),
    lastMsgId: toBigint(row[4]),
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

function toStr(v: SqlValue | undefined): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

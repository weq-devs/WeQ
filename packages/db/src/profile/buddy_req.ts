/**
 * `buddy_req_list_5` — Buddy request notifications.
 *
 * Column map:
 *   21204  timestamp       (INTEGER)
 *   21001  peerUid         (TEXT)
 *   20002  nick            (TEXT)
 *   21502  isAccepted      (INTEGER) - 0: yes, 1: pending
 *   21508  verifyMsg       (TEXT)
 *   21509  source          (TEXT)
 *   21505  status          (INTEGER) - 1: waiting, 2: accepted, 13: expired
 *   60001  sourceGroupCode (INTEGER)
 *   21501  initiator       (INTEGER) - 0: self, 1: others
 */

import type { NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

export interface BuddyRequest {
  timestamp: number;
  peerUid: string;
  nick: string;
  isAccepted: number;
  verifyMsg: string;
  source: string;
  status: number;
  sourceGroupCode: bigint;
  initiator: number;
}

export interface BuddyRequestDbOptions {
  dbPath: string;
  key: string;
}

const SELECT_COLUMNS = `"21204","21001","20002","21502","21508","21509","21505","60001","21501"`;

export class BuddyRequestDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: BuddyRequestDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key });
  }

  /**
   * List buddy requests, newest first.
   */
  async listRequests(limit = 100, offset = 0): Promise<BuddyRequest[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM buddy_req_list_5 ORDER BY "21204" DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map(rowToRequest);
  }

  close(): void {
    this.qq.close();
  }
}

function rowToRequest(row: SqlRow): BuddyRequest {
  return {
    timestamp: Number(row[0] ?? 0),
    peerUid: String(row[1] ?? ''),
    nick: String(row[2] ?? ''),
    isAccepted: Number(row[3] ?? 0),
    verifyMsg: String(row[4] ?? ''),
    source: String(row[5] ?? ''),
    status: Number(row[6] ?? 0),
    sourceGroupCode: toBigint(row[7]),
    initiator: Number(row[8] ?? 0),
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

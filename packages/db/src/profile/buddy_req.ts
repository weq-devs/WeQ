/**
 * `buddy_req_list_5` — Buddy request notifications.
 *
 * Column map:
 *   21204  timestamp       (INTEGER)
 *   21001  peerUid         (TEXT)
 *   20002  nick            (TEXT)
 *   21502  isAccepted      (INTEGER) - isInitiator: 0 对方发起，1 自己发起（沿用旧字段名）
 *   21508  verifyMsg       (TEXT)
 *   21509  source          (TEXT)
 *   21505  status          (INTEGER) - BuddyReqType 请求类型及处理结果
 *   60001  sourceGroupCode (INTEGER)
 *   21501  initiator       (INTEGER) - isDecide: 0 未处理，1 已处理（沿用旧字段名）
 */

import type { NtHelperBinding, SqlRow, SqlValue, DatabaseAlgorithms } from '@weq/native';
import { QqDb } from '../qq_db';

export interface BuddyRequest {
  timestamp: number;
  peerUid: string;
  nick: string;
  /** 21502（isInitiator）：0 对方发起，1 自己发起；保留旧字段名兼容调用方。 */
  isAccepted: number;
  verifyMsg: string;
  source: string;
  /** 21505（BuddyReqType）：请求类型及处理结果，不是来源类型码。 */
  status: number;
  sourceGroupCode: bigint;
  /** 21501（isDecide）：0 未处理，1 已处理；保留旧字段名兼容调用方。 */
  initiator: number;
}

export interface BuddyRequestDbOptions {
  dbPath: string;
  key?: string;
  algo?: DatabaseAlgorithms;
}

const SELECT_COLUMNS = `"21204","21001","20002","21502","21508","21509","21505","60001","21501"`;

export class BuddyRequestDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: BuddyRequestDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
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

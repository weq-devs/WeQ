/**
 * `group_essence` — Group Essential (pinned/featured) messages.
 *
 * Column map:
 *   60001  groupCode       (INTEGER)
 *   67501  msgSeq          (INTEGER)
 *   67502  msgRandom       (INTEGER)
 *   67503  senderUin       (INTEGER)
 *   67504  senderNick      (TEXT)
 *   67505  setStatus       (INTEGER) - 1: set, 2: cancelled
 *   67506  operatorUin     (INTEGER)
 *   67507  operatorNick    (TEXT)
 *   67508  timestamp       (INTEGER)
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

export interface GroupEssence {
  groupCode: bigint;
  msgSeq: number;
  msgRandom: number;
  senderUin: bigint;
  senderNick: string;
  /** 1: set, 2: cancelled */
  setStatus: number;
  operatorUin: bigint;
  operatorNick: string;
  timestamp: number;
}

export interface GroupEssenceDbOptions {
  dbPath: string;
  key: string;
  /** Database algorithms. */
  algo: DatabaseAlgorithms;
}

const SELECT_COLUMNS = `"60001","67501","67502","67503","67504","67505","67506","67507","67508"`;

export class GroupEssenceDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GroupEssenceDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * List essence messages for a group, newest first.
   */
  async listEssence(groupCode: bigint, limit = 50, offset = 0): Promise<GroupEssence[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_essence WHERE "60001" = ? ORDER BY "67508" DESC LIMIT ? OFFSET ?`,
      [groupCode, limit, offset],
    );
    return rows.map(rowToEssence);
  }

  close(): void {
    this.qq.close();
  }
}

function rowToEssence(row: SqlRow): GroupEssence {
  return {
    groupCode: toBigint(row[0]),
    msgSeq: Number(row[1] ?? 0),
    msgRandom: Number(row[2] ?? 0),
    senderUin: toBigint(row[3]),
    senderNick: String(row[4] ?? ''),
    setStatus: Number(row[5] ?? 0),
    operatorUin: toBigint(row[6]),
    operatorNick: String(row[7] ?? ''),
    timestamp: Number(row[8] ?? 0),
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

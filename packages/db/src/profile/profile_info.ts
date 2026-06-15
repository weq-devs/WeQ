/**
 * `profile_info_v6` — Detailed user profiles.
 *
 * Column map:
 *   1000   uid             (TEXT)
 *   1001   qid             (TEXT)
 *   1002   uin             (INTEGER)
 *   20002  nick            (TEXT)
 *   20004  avatarUrl       (TEXT)
 *   20006  birthYear       (INTEGER)
 *   20007  birthMonth      (INTEGER)
 *   20008  birthDay        (INTEGER)
 *   20009  remark          (TEXT)
 *   20011  signature       (TEXT)
 *   20057  customStatus    (BLOB/Protobuf)
 *   20070  intimacy        (INTEGER)
 *   20072  extRelation     (BLOB/Protobuf)
 *   24103  age             (INTEGER)
 *   24104  sigUpdateTime   (INTEGER)
 */

import { ProtoMsg } from '@weq/codec';
import { GroupRelationBody } from '@weq/codec/proto/profile/20072';
import { CustomStatusBody } from '@weq/codec/proto/profile/20057';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

const relationCodec = new ProtoMsg(GroupRelationBody);
const statusCodec = new ProtoMsg(CustomStatusBody);

export interface ExtensionRelation {
  preselectedIds: number[];
  displayId?: number;
}

export interface CustomStatus {
  id?: number;
  desc?: string;
}

export interface UserProfile {
  uid: string;
  qid: string;
  uin: bigint;
  nick: string;
  avatarUrl: string;
  birthYear: number;
  birthMonth: number;
  birthDay: number;
  remark: string;
  signature: string;
  intimacy: number;
  age: number;
  sigUpdateTime: number;
  isFriend: boolean;
  customStatus?: CustomStatus;
  extRelation?: ExtensionRelation;
}

export interface ProfileInfoDbOptions {
  dbPath: string;
  key: string;
  /** Database algorithms. */
  algo: DatabaseAlgorithms;
}

const SELECT_COLUMNS = `"1000","1001","1002","20002","20004","20006","20007","20008","20009","20011","20057","20070","20072","24103","24104"`;

export class ProfileInfoDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: ProfileInfoDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * Get profile by UID.
   */
  async getProfile(uid: string): Promise<UserProfile | null> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM profile_info_v6 WHERE "1000" = ? LIMIT 1`,
      [uid],
    );
    if (rows.length === 0) return null;
    return rowToProfile(rows[0]!);
  }

  /**
   * Get profile by UIN.
   */
  async getProfileByUin(uin: bigint): Promise<UserProfile | null> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM profile_info_v6 WHERE "1002" = ? LIMIT 1`,
      [uin],
    );
    if (rows.length === 0) return null;
    return rowToProfile(rows[0]!);
  }

  /**
   * List all cached profiles.
   */
  async listProfiles(limit = 100, offset = 0): Promise<UserProfile[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM profile_info_v6 LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map(rowToProfile);
  }

  close(): void {
    this.qq.close();
  }
}

function rowToProfile(row: SqlRow): UserProfile {
  const statusBlob = row[10];
  const relationBlob = row[12];
  const isFriend = relationBlob !== null && relationBlob !== undefined;

  let customStatus: CustomStatus | undefined;
  if (statusBlob instanceof Uint8Array) {
    try {
      const decoded = statusCodec.decode(statusBlob);
      if (decoded.status) {
        customStatus = {
          id: decoded.status.id,
          desc: decoded.status.desc,
        };
      }
    } catch {}
  }

  let extRelation: ExtensionRelation | undefined;
  if (relationBlob instanceof Uint8Array) {
    try {
      const decoded = relationCodec.decode(relationBlob);
      if (decoded.relation) {
        extRelation = {
          preselectedIds: decoded.relation.preselectedIds ?? [],
          displayId: decoded.relation.displayId,
        };
      }
    } catch {}
  }

  return {
    uid: String(row[0] ?? ''),
    qid: String(row[1] ?? ''),
    uin: toBigint(row[2]),
    nick: String(row[3] ?? ''),
    avatarUrl: String(row[4] ?? ''),
    birthYear: Number(row[5] ?? 0),
    birthMonth: Number(row[6] ?? 0),
    birthDay: Number(row[7] ?? 0),
    remark: String(row[8] ?? ''),
    signature: String(row[9] ?? ''),
    intimacy: Number(row[11] ?? 0),
    age: Number(row[13] ?? 0),
    sigUpdateTime: Number(row[14] ?? 0),
    isFriend,
    customStatus,
    extRelation,
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

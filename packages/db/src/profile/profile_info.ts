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
 *   20014  gender          (INTEGER)
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
  gender: number; // 1: male, 2: female, 0: unknown
  customStatus?: CustomStatus;
  extRelation?: ExtensionRelation;
}

export interface ProfileInfoDbOptions {
  dbPath: string;
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

const SELECT_COLUMNS = `"1000","1001","1002","20002","20004","20006","20007","20008","20009","20011","20014","20057","20070","20072","24103","24104"`;

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
   * Batch-resolve nicknames by uid in one query. Returns a uid→nick map for the
   * uids that have a cached profile (missing/empty ones are simply absent).
   * Only reads uid + nick — cheap enough to call per search result set.
   */
  async nicksByUids(uids: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(uids.filter((uid) => uid))];
    if (unique.length === 0) return {};
    const placeholders = unique.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT "1000","20002" FROM profile_info_v6 WHERE "1000" IN (${placeholders})`,
      unique,
    );
    const out: Record<string, string> = {};
    for (const row of rows) {
      const uid = String(row[0] ?? '');
      const nick = String(row[1] ?? '');
      if (uid && nick) out[uid] = nick;
    }
    return out;
  }

  /**
   * Batch-resolve full profiles by uid in one query. Returns the profiles for
   * the uids that have a cached row (missing ones are simply absent — no null
   * placeholders). Lets the renderer fill many buddy / notify profiles without
   * issuing one query per uid.
   */
  async profilesByUids(uids: string[]): Promise<UserProfile[]> {
    const unique = [...new Set(uids.filter((uid) => uid))];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM profile_info_v6 WHERE "1000" IN (${placeholders})`,
      unique,
    );
    return rows.map(rowToProfile);
  }

  /**
   * List ALL friends (the authoritative buddy_list) joined with their profile
   * intimacy, ordered 亲密度高→低. Single paginated query backing the "好友亲密度
   * 排行" lightbox (infinite-scroll). buddy_list and profile_info_v6 share one
   * db file, so this is a plain JOIN — every friend is included, even those with
   * 0/unknown intimacy (COALESCE sorts them to the bottom). Tie-break by uid so
   * pagination stays stable when many friends share intimacy 0.
   */
  async listFriendsByIntimacy(
    limit = 100,
    offset = 0,
  ): Promise<Array<{ uid: string; uin: string; nick: string; remark: string; intimacy: number }>> {
    const rows = await this.qq.query(
      `SELECT b."1000", b."1002", p."20002", p."20009", p."20070"
       FROM buddy_list b
       LEFT JOIN profile_info_v6 p ON b."1000" = p."1000"
       ORDER BY COALESCE(p."20070", 0) DESC, b."1000" ASC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map((row) => ({
      uid: String(row[0] ?? ''),
      uin: row[1] === null || row[1] === undefined ? '' : String(row[1]),
      nick: String(row[2] ?? ''),
      remark: String(row[3] ?? ''),
      intimacy: Number(row[4] ?? 0),
    }));
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
  const genderRaw = row[10];
  const statusBlob = row[11];
  const intimacyRaw = row[12];
  const relationBlob = row[13];
  const ageRaw = row[14];
  const sigUpdateTimeRaw = row[15];

  const isFriend = relationBlob !== null && relationBlob !== undefined;

  let gender = 0;
  const genderNum = genderRaw !== null && genderRaw !== undefined ? Number(genderRaw) : 0;
  if (genderNum === 1 || genderNum === 2) {
    gender = genderNum;
  }

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
    gender,
    intimacy: Number(intimacyRaw ?? 0),
    age: Number(ageRaw ?? 0),
    sigUpdateTime: Number(sigUpdateTimeRaw ?? 0),
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

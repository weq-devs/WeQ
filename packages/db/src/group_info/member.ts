/**
 * `group_member3` — Group membership records.
 *
 * Column map:
 *   64003  card            (TEXT) - Group-specific nickname
 *   20002  nick            (TEXT) - Global QQ nickname
 *   60001  groupCode       (INTEGER)
 *   1000   uid             (TEXT) - NT UID
 *   1002   uin             (INTEGER) - QQ Number
 *   64007  joinTime        (INTEGER)
 *   64008  lastSpeakTime   (INTEGER)
 *   64009  muteUntil       (INTEGER) - Last forbidden release timestamp
 *   64010  adminFlag       (INTEGER) - 0: member, 1: admin
 *   64015  field64015      (INTEGER)
 *   64016  memberFlag      (INTEGER) - 0: active member, 1: left
 *   64023  customTitle     (TEXT) - Custom title/rank
 *   64035  memberLevel     (INTEGER)
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

export interface GroupMember {
  groupCode: bigint;
  uid: string;
  uin: bigint;
  card: string;
  nick: string;
  joinTime: number;
  lastSpeakTime: number;
  muteUntil: number;
  adminFlag: number;
  memberFlag: number;
  customTitle: string;
  memberLevel: number;
}

export interface GroupMemberDbOptions {
  dbPath: string;
  key: string;
  /** Database algorithms. */
  algo: DatabaseAlgorithms;
}

const SELECT_COLUMNS = `"60001","1000","1002","64003","20002","64007","64008","64009","64010","64016","64023","64035"`;

export class GroupMemberDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GroupMemberDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * List all members of a specific group.
   * Filters by active members (64016 = 0) by default.
   */
  async listMembersInGroup(groupCode: bigint, limit = 100, offset = 0): Promise<GroupMember[]> {
    const rows = await this.qq.query(
      `SELECT m."60001", m."1000", m."1002", m."64003", m."20002", m."64007", m."64008", m."64009", m."64010", m."64016", m."64023", m."64035"
       FROM group_member3 m
       LEFT JOIN group_detail_info_ver1 d ON m."60001" = d."60001"
       WHERE m."60001" = ? AND m."64016" = 0
       ORDER BY (m."1000" = d."60002") DESC, m."64010" DESC, m."64007" ASC
       LIMIT ? OFFSET ?`,
      [groupCode, limit, offset],
    );
    return rows.map(rowToMember);
  }

  /**
   * List all groups a specific user belongs to.
   */
  async listUserGroups(uid: string, limit = 100, offset = 0): Promise<GroupMember[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_member3 WHERE "1000" = ? AND "64016" = 0 LIMIT ? OFFSET ?`,
      [uid, limit, offset],
    );
    return rows.map(rowToMember);
  }

  /**
   * Get a single member's info.
   */
  async getMember(groupCode: bigint, uid: string): Promise<GroupMember | null> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_member3 WHERE "60001" = ? AND "1000" = ? LIMIT 1`,
      [groupCode, uid],
    );
    if (rows.length === 0) return null;
    return rowToMember(rows[0]!);
  }

  /**
   * Batch-fetch members by uid in a single query. Used to resolve message
   * senders that fall outside the paginated member list without firing one
   * query per uid. Returns only the members found (no nulls / ordering).
   */
  async getMembersByUids(groupCode: bigint, uids: string[]): Promise<GroupMember[]> {
    const unique = [...new Set(uids.filter((uid) => uid))];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_member3 WHERE "60001" = ? AND "1000" IN (${placeholders})`,
      [groupCode, ...unique],
    );
    return rows.map(rowToMember);
  }

  close(): void {
    this.qq.close();
  }
}

function rowToMember(row: SqlRow): GroupMember {
  return {
    groupCode: toBigint(row[0]),
    uid: String(row[1] ?? ''),
    uin: toBigint(row[2]),
    card: String(row[3] ?? ''),
    nick: String(row[4] ?? ''),
    joinTime: Number(row[5] ?? 0),
    lastSpeakTime: Number(row[6] ?? 0),
    muteUntil: Number(row[7] ?? 0),
    adminFlag: Number(row[8] ?? 0),
    memberFlag: Number(row[9] ?? 0),
    customTitle: String(row[10] ?? ''),
    memberLevel: Number(row[11] ?? 0),
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

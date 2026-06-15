/**
 * `group_member_level_info` — Group member level definitions.
 *
 * Column map:
 *   60001  groupCode       (INTEGER)
 *   67100  memberLevel     (INTEGER) - Specific member's level? Or generic info?
 *   67103  levelConfig     (BLOB/Protobuf) - Level to name mappings.
 */

import { ProtoMsg } from '@weq/codec';
import { GroupMemberLevelBody } from '@weq/codec/proto/group_info/67103';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

const levelCodec = new ProtoMsg(GroupMemberLevelBody);

export interface GroupLevelConfigItem {
  level: number;
  levelName: string;
}

export interface GroupMemberLevelInfo {
  groupCode: bigint;
  memberLevel: number;
  levelConfigs: GroupLevelConfigItem[];
}

export interface GroupMemberLevelInfoDbOptions {
  dbPath: string;
  key: string;
  /** Database algorithms. */
  algo: DatabaseAlgorithms;
}

const SELECT_COLUMNS = `"60001","67100","67103"`;

export class GroupMemberLevelInfoDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GroupMemberLevelInfoDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * Get level info for a group.
   */
  async getLevelInfo(groupCode: bigint): Promise<GroupMemberLevelInfo | null> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_member_level_info WHERE "60001" = ? LIMIT 1`,
      [groupCode],
    );
    if (rows.length === 0) return null;
    return rowToLevelInfo(rows[0]!);
  }

  close(): void {
    this.qq.close();
  }
}

function rowToLevelInfo(row: SqlRow): GroupMemberLevelInfo {
  const blob = row[2];
  let levelConfigs: GroupLevelConfigItem[] = [];
  
  if (blob instanceof Uint8Array) {
    try {
      const decoded = levelCodec.decode(blob);
      levelConfigs = (decoded.items ?? []).map(item => ({
        level: item.level ?? 0,
        levelName: item.levelName ?? '',
      }));
    } catch {
      /* ignore decode errors */
    }
  }

  return {
    groupCode: toBigint(row[0]),
    memberLevel: Number(row[1] ?? 0),
    levelConfigs,
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

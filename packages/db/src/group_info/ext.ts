/**
 * `group_ext_list` — Extended group metadata.
 *
 * Column map:
 *   60001  groupCode        (INTEGER, PK)
 *   66720  activityScore    (INTEGER)  — 群活跃度分值
 *   66721  luckyCharId      (INTEGER)  — 幸运字符 ID（0 = 无）
 *   66722  luckyCharLitCount (INTEGER) — 幸运字符点亮个数
 *   66723  luckyCharContent (TEXT)     — 幸运字符文本（如 "yyds"）
 *   66726  periodMsgCount   (INTEGER)  — 周期内消息量（大数，非 0 才有统计）
 *   66730  hasActivity      (INTEGER)  — 布尔标志：群是否有近期活动记录
 *   66731  activityRecordId (INTEGER)  — 活动相关 64 位 ID（0 = 无）
 *   66732  ownerInfo        (BLOB)     — protobuf: ownerUid + ownerUin
 *   66733  hasSpecialMark   (INTEGER)  — 布尔标志：含义待确认
 */

import { ProtoMsg } from '@weq/codec';
import { GroupOwnerInfoBody } from '@weq/codec/proto/group_info/66732';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

const ownerInfoCodec = new ProtoMsg(GroupOwnerInfoBody);

export interface GroupOwnerInfo {
  ownerUid: string;
  /** Numeric QQ number (legacy UIN). Empty string when unknown. */
  ownerUin: string;
}

export interface GroupExt {
  groupCode: bigint;
  /** 群活跃度分值（越高越活跃）。 */
  activityScore: number;
  /** 幸运字符 ID（0 = 未设置）。 */
  luckyCharId: number;
  /** 幸运字符点亮个数。 */
  luckyCharLitCount: number;
  /** 幸运字符文本（空字符串 = 未设置）。 */
  luckyCharContent: string;
  /** 周期内消息量。0 表示无统计数据。 */
  periodMsgCount: number;
  /** 群近期是否有活动记录。 */
  hasActivity: boolean;
  /** 活动相关 64 位标识符（0n = 无）。 */
  activityRecordId: bigint;
  /** 群主 uid + uin（解码自 66732 BLOB）。 */
  ownerInfo?: GroupOwnerInfo;
  /** 含义待确认的布尔标志。 */
  hasSpecialMark: boolean;
}

export interface GroupExtDbOptions {
  dbPath: string;
  key?: string;
  algo?: DatabaseAlgorithms;
}

const SELECT_COLUMNS =
  `"60001","66720","66721","66722","66723","66726","66730","66731","66732","66733"`;

export class GroupExtDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GroupExtDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  async getExt(groupCode: bigint): Promise<GroupExt | null> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_ext_list WHERE "60001" = ? LIMIT 1`,
      [groupCode],
    );
    if (rows.length === 0) return null;
    return rowToExt(rows[0]!);
  }

  async listAll(limit = 500, offset = 0): Promise<GroupExt[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_ext_list LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map(rowToExt);
  }

  close(): void {
    this.qq.close();
  }
}

function rowToExt(row: SqlRow): GroupExt {
  const ownerBlob = row[8];
  let ownerInfo: GroupOwnerInfo | undefined;
  if (ownerBlob instanceof Uint8Array && ownerBlob.byteLength > 0) {
    try {
      const decoded = ownerInfoCodec.decode(ownerBlob);
      const inner = decoded.ownerInfo;
      if (inner?.ownerUid) {
        ownerInfo = {
          ownerUid: inner.ownerUid,
          ownerUin: inner.ownerUin != null ? String(inner.ownerUin) : '',
        };
      }
    } catch {}
  }

  return {
    groupCode: toBigint(row[0]),
    activityScore: Number(row[1] ?? 0),
    luckyCharId: Number(row[2] ?? 0),
    luckyCharLitCount: Number(row[3] ?? 0),
    luckyCharContent: String(row[4] ?? ''),
    periodMsgCount: Number(row[5] ?? 0),
    hasActivity: toBool(row[6]),
    activityRecordId: toBigint(row[7]),
    ownerInfo,
    hasSpecialMark: toBool(row[9]),
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

function toBool(v: SqlValue | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'bigint') return v !== 0n;
  return Boolean(v);
}

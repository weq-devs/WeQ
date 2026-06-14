/**
 * `group_detail_info_ver1` — Group detailed metadata.
 *
 * Column map:
 *   60001  groupCode       (INTEGER)
 *   60007  groupName       (TEXT)
 *   60216  pinnedAnnounce  (TEXT)
 *   60217  description     (TEXT)
 *   60026  remark          (TEXT)
 *   60002  ownerUid        (TEXT)
 *   60004  createTime      (INTEGER)
 *   60005  maxMemberCount  (INTEGER)
 *   60006  memberCount     (INTEGER)
 *   60218  labels          (TEXT)
 *   60224  entranceQ       (TEXT)
 *   60240  descOld         (BLOB) - Old QQ migrated data
 *   60340  leaveFlag       (INTEGER) - 0: member, 1: left
 *   60241  customLabels    (BLOB) - Custom labels list
 *   60242  address         (BLOB) - Group location info
 */

import { ProtoMsg } from '@weq/codec';
import { GroupAddressBody } from '@weq/codec/proto/group_info/60242';
import { GroupCustomLabelsBody } from '@weq/codec/proto/group_info/60241';
import type { NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

const addressCodec = new ProtoMsg(GroupAddressBody);
const labelsCodec = new ProtoMsg(GroupCustomLabelsBody);

export interface GroupAddress {
  setterUid?: string;
  setTimestamp?: bigint;
  locationId?: number;
  longitude?: number;
  latitude?: number;
  locationName?: string;
}

export interface GroupCustomLabel {
  groupCode?: bigint;
  setterUid?: string;
  labelId?: string;
  setTimestamp?: bigint;
  content?: string;
}

export interface GroupDetail {
  groupCode: bigint;
  groupName: string;
  pinnedAnnounce: string;
  description: string;
  remark: string;
  ownerUid: string;
  createTime: number;
  maxMemberCount: number;
  memberCount: number;
  labels: string;
  entranceQ: string;
  leaveFlag: number;
  customLabels: GroupCustomLabel[];
  address?: GroupAddress;
}

export interface GroupDetailDbOptions {
  dbPath: string;
  key: string;
}

const SELECT_COLUMNS = `"60001","60007","60216","60217","60026","60002","60004","60005","60006","60218","60224","60340","60241","60242"`;

export class GroupDetailDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GroupDetailDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key });
  }

  /**
   * Get detail for a single group.
   */
  async getDetail(groupCode: bigint): Promise<GroupDetail | null> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_detail_info_ver1 WHERE "60001" = ? LIMIT 1`,
      [groupCode],
    );
    if (rows.length === 0) return null;
    return rowToDetail(rows[0]!);
  }

  /**
   * List details for all groups.
   */
  async listAll(limit = 100, offset = 0): Promise<GroupDetail[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_detail_info_ver1 LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map(rowToDetail);
  }

  close(): void {
    this.qq.close();
  }
}

function rowToDetail(row: SqlRow): GroupDetail {
  const customLabelsBlob = row[12];
  const addressBlob = row[13];

  let customLabels: GroupCustomLabel[] = [];
  if (customLabelsBlob instanceof Uint8Array) {
    try {
      const decoded = labelsCodec.decode(customLabelsBlob);
      customLabels = (decoded.labels ?? []).map(item => ({
        groupCode: item.groupCode,
        setterUid: item.setterUid,
        labelId: item.labelId,
        setTimestamp: item.setTimestamp,
        content: item.content,
      }));
    } catch {}
  }

  let address: GroupAddress | undefined;
  if (addressBlob instanceof Uint8Array) {
    try {
      const decoded = addressCodec.decode(addressBlob);
      address = {
        setterUid: decoded.setterUid,
        setTimestamp: decoded.setTimestamp,
        locationId: decoded.locationId,
        longitude: decoded.longitude,
        latitude: decoded.latitude,
        locationName: decoded.locationName,
      };
    } catch {}
  }

  return {
    groupCode: toBigint(row[0]),
    groupName: String(row[1] ?? ''),
    pinnedAnnounce: String(row[2] ?? ''),
    description: String(row[3] ?? ''),
    remark: String(row[4] ?? ''),
    ownerUid: String(row[5] ?? ''),
    createTime: Number(row[6] ?? 0),
    maxMemberCount: Number(row[7] ?? 0),
    memberCount: Number(row[8] ?? 0),
    labels: String(row[9] ?? ''),
    entranceQ: String(row[10] ?? ''),
    leaveFlag: Number(row[11] ?? 0),
    customLabels,
    address,
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

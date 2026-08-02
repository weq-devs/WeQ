import { ProtoMsg } from '@weq/codec';
import {
  GroupNotifyGroupInfoColumn,
  GroupNotifyOperatedColumn,
  GroupNotifyOperatorColumn,
  GroupNotifyActorColumn,
} from '@weq/codec/proto/group_info/notify';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

const groupCodec = new ProtoMsg(GroupNotifyGroupInfoColumn);
const operatedCodec = new ProtoMsg(GroupNotifyOperatedColumn);
const operatorCodec = new ProtoMsg(GroupNotifyOperatorColumn);
const actorCodec = new ProtoMsg(GroupNotifyActorColumn);

export enum GroupNotifyStatus {
  Apply = 1,
  SetAdmin = 3,
  Kicked = 6,
  Rejected = 11,
  Quit = 13,
  RevokeAdmin = 15,
}

/** 61003 — 这条通知的处理状态。 */
export enum GroupNotifyVerifyStatus {
  /** 无需处理（退群/被踢等纯知会类通知）。 */
  NoAction = 0,
  /** 待处理（入群申请挂着，等管理员点同意/拒绝）。 */
  Pending = 1,
  Agreed = 2,
  Refused = 3,
}

export interface GroupNotifyUserInfo {
  uid: string;
  nick: string;
  /** QQ 号。列里没有，由 service 层查 profile_info_v6 补上（未命中为 ''）。 */
  uin?: string;
}

export interface GroupNotifyGroupInfo {
  groupUin: bigint;
  groupName: string;
}

export interface GroupNotify {
  msgTime: number; // ms
  status: GroupNotifyStatus;
  verifyStatus: GroupNotifyVerifyStatus;
  groupInfo?: GroupNotifyGroupInfo;
  operatedUser?: GroupNotifyUserInfo;
  operatorUser?: GroupNotifyUserInfo;
  opTime: number; // s
  remark: string;
  systemRemark: string;
  sourceTable: 'group_notify_list' | 'doubt_group_notify_list';
}

export interface GroupNotifyDbOptions {
  dbPath: string;
  key?: string;
  algo?: DatabaseAlgorithms;
}

const SELECT_COLUMNS = `"61001","61002","61003","61004","61005","61006","61007","61008","61010","61011"`;

export class GroupNotifyDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GroupNotifyDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  async listNormal(limit = 100, offset = 0): Promise<GroupNotify[]> {
    return this.listFromTable('group_notify_list', limit, offset);
  }

  async listDoubt(limit = 100, offset = 0): Promise<GroupNotify[]> {
    return this.listFromTable('doubt_group_notify_list', limit, offset);
  }

  private async listFromTable(
    tableName: 'group_notify_list' | 'doubt_group_notify_list',
    limit: number,
    offset: number,
  ): Promise<GroupNotify[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM ${tableName} ORDER BY "61001" DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map(row => rowToNotify(row, tableName));
  }

  close(): void {
    this.qq.close();
  }
}

function rowToNotify(
  row: SqlRow,
  sourceTable: 'group_notify_list' | 'doubt_group_notify_list',
): GroupNotify {
  const groupBlob = row[3];
  const operatedBlob = row[4];
  const operatorBlob = row[5];
  const actorBlob = row[6];

  let groupInfo: GroupNotifyGroupInfo | undefined;
  if (groupBlob instanceof Uint8Array) {
    try {
      const decoded = groupCodec.decode(groupBlob);
      if (decoded.body) {
        groupInfo = {
          groupUin: toBigint(decoded.body.groupUin),
          groupName: String(decoded.body.groupName ?? ''),
        };
      }
    } catch {}
  }

  let operatedUser: GroupNotifyUserInfo | undefined;
  if (operatedBlob instanceof Uint8Array) {
    try {
      const decoded = operatedCodec.decode(operatedBlob);
      if (decoded.body) {
        operatedUser = {
          uid: String(decoded.body.uid ?? ''),
          nick: String(decoded.body.nick ?? ''),
        };
      }
    } catch {}
  }

  // 处理人：实测 61006 恒为 null，操作人真身在 61007（"操作发起人"）。两列都试，
  // 先 61007 后 61006。
  let operatorUser: GroupNotifyUserInfo | undefined;
  if (actorBlob instanceof Uint8Array) {
    try {
      const decoded = actorCodec.decode(actorBlob);
      if (decoded.body) {
        operatorUser = {
          uid: String(decoded.body.uid ?? ''),
          nick: String(decoded.body.nick ?? ''),
        };
      }
    } catch {}
  }

  if (!operatorUser && operatorBlob instanceof Uint8Array) {
    try {
      const decoded = operatorCodec.decode(operatorBlob);
      if (decoded.body) {
        operatorUser = {
          uid: String(decoded.body.uid ?? ''),
          nick: String(decoded.body.nick ?? ''),
        };
      }
    } catch {}
  }

  return {
    msgTime: Number(toBigint(row[0]) / 1000n), // 用户说删除末三位，即除以1000
    status: Number(row[1] ?? 0) as GroupNotifyStatus,
    verifyStatus: Number(row[2] ?? 0) as GroupNotifyVerifyStatus,
    groupInfo,
    operatedUser,
    operatorUser,
    opTime: Number(row[7] ?? 0),
    remark: String(row[8] ?? ''),
    systemRemark: String(row[9] ?? ''),
    sourceTable,
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

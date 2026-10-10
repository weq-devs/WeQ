// OIDB 0x8FC_3 —— 设置群成员群名片（群昵称）。
//
//   f1 groupUin   (uint32)  群号
//   f3 body       { f1 targetUid (string), f8 targetName (string) }
//
// ⚠️ 注意字段号：body 在 tag 3、群名片名在 **tag 8**（不是 tag 2/2）。写错会让
// 服务端以 OIDB error 1007 拒绝。与 0x8FC_2（群头衔）共用 body 外壳（tag 3）。
//
// 搬运自 SnowLuma `oidb-services/group-admin/set-member-card.ts`（与 Lagrange
// `OidbSvcTrpcTcp0x8FC`、NapCat `Oidb.0x8FC_3` 逐字节一致）。
//
// 签名：LagrangeV2 白名单里有 `OidbSvcTrpcTcp.0x8fc_3`，needSign = true。

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const RENAME_MEMBER_BODY = message([
  { name: 'targetUid', tag: 1, type: 'string' },
  { name: 'targetName', tag: 8, type: 'string' },
]);
const RENAME_MEMBER_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'body', tag: 3, type: RENAME_MEMBER_BODY },
]);

/** 回包是空 ack。 */
const RENAME_MEMBER_RESP = message([]);

export interface SetGroupMemberCardParams {
  /** 群号。 */
  groupId: number;
  /** 目标成员的 NT uid。 */
  targetUid: string;
  /** 新群名片；空串 = 清除。 */
  card: string;
}

export namespace SetGroupMemberCard {
  export const command = 0x8fc;
  export const subCommand = 3;
  export const needSign = true;
  export const reqSchema = RENAME_MEMBER_REQ;
  export const respSchema = RENAME_MEMBER_RESP;

  export type Params = SetGroupMemberCardParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    if (!p.targetUid) throw new Error('targetUid 不能为空');
    // card 为空串是合法的「清除群名片」，但 proto3 会省略 —— 这里照 SnowLuma 的
    // 语义允许空串（等于清除），不上 force。
    return { groupUin: p.groupId, body: { targetUid: p.targetUid, targetName: p.card } };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetGroupMemberCard as OidbSpec<Params, void>, params);
}

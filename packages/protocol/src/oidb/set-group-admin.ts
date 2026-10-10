// OIDB 0x1096_1 —— 设置 / 取消群管理员。
//
//   f1 groupUin  (uint32)  群号
//   f2 uid       (string)  目标成员 uid（**不是** uin）
//   f3 isAdmin   (bool)    true = 设为管理员，false = 取消
//
// 搬运自 SnowLuma `oidb-services/group-admin/set-admin.ts`。
//
// 签名：LagrangeV2 白名单里没有 0x1096，needSign = false。

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const SET_ADMIN_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'uid', tag: 2, type: 'string' },
  { name: 'isAdmin', tag: 3, type: 'bool' },
]);

/** 回包是空 ack。 */
const SET_ADMIN_RESP = message([]);

export interface SetGroupAdminParams {
  /** 群号。 */
  groupId: number;
  /** 目标成员的 NT uid。 */
  targetUid: string;
  /** true = 设为管理员，false = 取消。 */
  enable: boolean;
}

export namespace SetGroupAdmin {
  export const command = 0x1096;
  export const subCommand = 1;
  export const needSign = false;
  export const reqSchema = SET_ADMIN_REQ;
  export const respSchema = SET_ADMIN_RESP;

  export type Params = SetGroupAdminParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    if (!p.targetUid) throw new Error('targetUid 不能为空');
    return { groupUin: p.groupId, uid: p.targetUid, isAdmin: p.enable };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetGroupAdmin as OidbSpec<Params, void>, params);
}

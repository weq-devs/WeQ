// OIDB 0x89A_15 —— 修改群名称。
//
// 搬运自 SnowLuma `packages/protocol/src/oidb-services/group-admin/set-group-name.ts`
// 与 Lagrange.Core `OidbSvcTrpcTcp0x89A_15Body`：
//
//   f1 groupUin   (uint32)  群号
//   f2 body       { f3 targetName (string) }   新群名
//
// ⚠️ 群名在 inner body 的 f3（不是 f1/f2）：写到 f2 服务端会以 OIDB error 1006 拒绝。
//
// 签名：LagrangeV2 白名单里有 `OidbSvcTrpcTcp.0x89a_15`，所以 needSign = true。

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

/** 0x89A_15 inner body：groupUin + body{ targetName }。 */
const RENAME_GROUP_BODY = message([{ name: 'targetName', tag: 3, type: 'string' }]);
const RENAME_GROUP_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'body', tag: 2, type: RENAME_GROUP_BODY },
]);

/** 回包是空 ack。 */
const RENAME_GROUP_RESP = message([]);

export interface SetGroupNameParams {
  /** 群号。 */
  groupId: number;
  /** 新群名称。 */
  name: string;
}

export namespace SetGroupName {
  export const command = 0x89a;
  export const subCommand = 15;
  /** 白名单命令 → 需要签名。 */
  export const needSign = true;
  export const reqSchema = RENAME_GROUP_REQ;
  export const respSchema = RENAME_GROUP_RESP;

  export type Params = SetGroupNameParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    if (!p.name.trim()) throw new Error('name（群名称）不能为空');
    return { groupUin: p.groupId, body: { targetName: p.name } };
  };

  /** 空 ack，无字段可解。 */
  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetGroupName as OidbSpec<Params, void>, params);
}

// OIDB 0x8A0_1 —— 踢出单个群成员（群主 / 管理员）。
//
//   f1 groupUin          (uint32)  群号
//   f3 targetUid         (string)  目标成员 uid（**不是** uin）
//   f4 rejectAddRequest  (bool)    是否拒绝该成员后续的加群申请
//   f5 reason            (string)  踢出理由（可空）
//
// 回包 f2 results（repeated { f1 result, f2 uid }）：信封 errorCode=0 **不代表成功**，
// 要逐个看 result（0 或被省略 = 成功）。这里非 0 直接抛错。
//
// 搬运自 SnowLuma `oidb-services/group-admin/kick-member.ts`。
//
// 签名：LagrangeV2 白名单里只有 0x8a0_0，没有 0x8a0_1，needSign = false。

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const KICK_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'targetUid', tag: 3, type: 'string' },
  { name: 'rejectAddRequest', tag: 4, type: 'bool' },
  { name: 'reason', tag: 5, type: 'string' },
]);

const KICK_RESULT = message([
  { name: 'result', tag: 1, type: 'uint32' },
  { name: 'uid', tag: 2, type: 'string' },
]);
const KICK_RESP = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'results', tag: 2, type: KICK_RESULT, repeated: true },
]);

export interface KickGroupMemberParams {
  /** 群号。 */
  groupId: number;
  /** 目标成员的 NT uid。 */
  targetUid: string;
  /** 是否拒绝该成员的后续加群申请。 */
  reject: boolean;
  /** 踢出理由（可选）。 */
  reason?: string;
}

export namespace KickGroupMember {
  export const command = 0x8a0;
  export const subCommand = 1;
  export const needSign = false;
  export const reqSchema = KICK_REQ;
  export const respSchema = KICK_RESP;

  export type Params = KickGroupMemberParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    if (!p.targetUid) throw new Error('targetUid 不能为空');
    return {
      groupUin: p.groupId,
      targetUid: p.targetUid,
      rejectAddRequest: p.reject,
      reason: p.reason ?? '',
    };
  };

  export const deserialize = (body: Record<string, unknown>): void => {
    const results = (body.results as Array<Record<string, unknown>> | undefined) ?? [];
    for (const item of results) {
      const code = Number(item.result ?? 0);
      if (code !== 0) {
        throw new Error(`踢出群成员失败：result=${code}（uid=${String(item.uid ?? '')}）`);
      }
    }
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, KickGroupMember as OidbSpec<Params, void>, params);
}

// OIDB 0x1253_1 —— 禁言单个群成员。
//
//   f1 groupUin   (uint32)  群号
//   f2 type       (uint32)  固定 1
//   f3 body       { f1 targetUid (string), f2 duration (uint32) }
//
// `duration` 单位秒；服务端把 0 当作「立即解除禁言」。
//
// 搬运自 SnowLuma `oidb-services/group-admin/mute-member.ts`。
//
// 签名：LagrangeV2 白名单里没有 0x1253，needSign = false。

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const MUTE_MEMBER_BODY = message([
  { name: 'targetUid', tag: 1, type: 'string' },
  { name: 'duration', tag: 2, type: 'uint32' },
]);
const MUTE_MEMBER_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'type', tag: 2, type: 'uint32' },
  { name: 'body', tag: 3, type: MUTE_MEMBER_BODY },
]);

/** 回包是空 ack。 */
const MUTE_MEMBER_RESP = message([]);

export interface MuteGroupMemberParams {
  /** 群号。 */
  groupId: number;
  /** 目标成员的 NT uid。 */
  targetUid: string;
  /** 禁言时长（秒）。0 = 立即解除禁言。 */
  duration: number;
}

export namespace MuteGroupMember {
  export const command = 0x1253;
  export const subCommand = 1;
  export const needSign = false;
  export const reqSchema = MUTE_MEMBER_REQ;
  export const respSchema = MUTE_MEMBER_RESP;

  export type Params = MuteGroupMemberParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    if (!p.targetUid) throw new Error('targetUid 不能为空');
    if (!Number.isSafeInteger(p.duration) || p.duration < 0) {
      throw new Error(`duration 必须是非负整数（秒），收到 ${String(p.duration)}`);
    }
    return { groupUin: p.groupId, type: 1, body: { targetUid: p.targetUid, duration: p.duration } };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, MuteGroupMember as OidbSpec<Params, void>, params);
}

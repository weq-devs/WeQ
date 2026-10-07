// OIDB 0xEAC —— 设置 / 取消群精华消息。
//   subCommand 1 = 设为精华，2 = 移出精华
//
//   f1 groupUin   (uint32)  群号
//   f2 sequence   (uint32)  被操作消息的 msgSeq
//   f3 random     (uint32)  该消息的 wire 层 random（服务端据此定位消息身份）
//
// `random` 是消息发送时服务端分配的随机值，要随原始消息一起取到再回填。
//
// 搬运自 SnowLuma `oidb-services/interaction/set-essence.ts`。
//
// 签名：LagrangeV2 白名单里没有 0xEAC，needSign = false。

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const ESSENCE_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'sequence', tag: 2, type: 'uint32' },
  { name: 'random', tag: 3, type: 'uint32' },
]);

/** 回包是空 ack。 */
const ESSENCE_RESP = message([]);

export interface SetGroupEssenceParams {
  /** 群号。 */
  groupId: number;
  /** 被操作消息的 msgSeq。 */
  sequence: number;
  /** 该消息的 wire 层 random。 */
  random: number;
  /** true = 设为精华，false = 移出精华。 */
  enable: boolean;
}

export namespace SetGroupEssence {
  export const command = 0xeac;
  /** 由 {@link resolvedSubCommand} 动态决定（1 设 / 2 撤）。 */
  export const subCommand = 1;
  export const needSign = false;
  export const reqSchema = ESSENCE_REQ;
  export const respSchema = ESSENCE_RESP;

  export type Params = SetGroupEssenceParams;

  /** 1 = 设置，2 = 取消。 */
  export const resolveSubCommand = (p: Params): number => (p.enable ? 1 : 2);

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    if (!Number.isSafeInteger(p.sequence) || p.sequence <= 0) {
      throw new Error(`sequence 必须是正整数，收到 ${String(p.sequence)}`);
    }
    return { groupUin: p.groupId, sequence: p.sequence, random: p.random };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetGroupEssence as OidbSpec<Params, void>, params);
}

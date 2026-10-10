// OIDB 0x89A_0 —— 群全员禁言开 / 关。
//
// `state`：0xFFFFFFFF = 永久全员禁言，0 = 解除。该值与 (0x89A, 0) 上其它命令
// （SetAddOption / SetSearch / SetGroupName 同族）靠 body 形状区分；state=0 必须
// **显式上 wire**（proto3 默认省略 0，会让服务端与别的命令混淆），所以 schema 用 force。
//
// 搬运自 SnowLuma `oidb-services/group-admin/mute-all.ts`。
//
// 签名：LagrangeV2 白名单里有 `OidbSvcTrpcTcp.0x89a_0`，needSign = true。

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

/** `muteState.state` 在 tag 17（不是 1）。 */
const MUTE_ALL_STATE = message([{ name: 'state', tag: 17, type: 'uint32', force: true }]);
const MUTE_ALL_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'muteState', tag: 2, type: MUTE_ALL_STATE },
]);

/** 回包是空 ack。 */
const MUTE_ALL_RESP = message([]);

/** 永久禁言的 state 常量。 */
export const MUTE_ALL_PERMANENT = 0xffffffff;

export interface MuteGroupAllParams {
  /** 群号。 */
  groupId: number;
  /** true = 全员禁言，false = 解除。 */
  enable: boolean;
}

export namespace MuteGroupAll {
  export const command = 0x89a;
  export const subCommand = 0;
  export const needSign = true;
  export const reqSchema = MUTE_ALL_REQ;
  export const respSchema = MUTE_ALL_RESP;

  export type Params = MuteGroupAllParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    return {
      groupUin: p.groupId,
      muteState: { state: p.enable ? MUTE_ALL_PERMANENT : 0 },
    };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, MuteGroupAll as OidbSpec<Params, void>, params);
}

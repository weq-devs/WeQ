// OIDB 0xED3_1 —— 戳一戳（群聊 / 私聊）。
//
// 搬运自 SnowLuma `packages/protocol/src/oidb-services/interaction/send-poke.ts`
// 与 Lagrange.Core `NudgeService` / NapCat `SendPoke` transformer（三边字段完全一致）。
//
// 信封形状群聊/私聊相同，靠 `groupUin` / `friendUin` 哪个非零区分：
//   - 群聊戳：groupUin = 群号，uin = 被戳成员（缺省等于群号）
//   - 私聊戳：friendUin = 对方 uin，uin = 被戳人（缺省等于对方）
//
// `ext` 是 QQ-NT 的「双击 / 抖动」子类型，SnowLuma 固定发 0，这里照搬。
// 字段号注意：friendUin 在 5、ext 在 6（不是 3/4），写错服务端读不到。
//
// 与「窗口抖动」的区别：窗口抖动是私聊消息里的 `commonElem serviceType=2`
// 元素（见 `../msg/send-elements.ts` 的 poke 元素），走 MessageSvc.PbSendMsg；
// 这里这条 OIDB 才是聊天窗口里那个「戳一戳」灰条，群聊/私聊都能发。

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

/** 0xED3_1 的 inner body：uin / groupUin / friendUin / ext。 */
const POKE_REQ = message([
  { name: 'uin', tag: 1, type: 'uint32' },
  { name: 'groupUin', tag: 2, type: 'uint32' },
  { name: 'friendUin', tag: 5, type: 'uint32' },
  { name: 'ext', tag: 6, type: 'uint32' },
]);

/** 回包是空 ack（OIDB 外层 errorCode=0，无 body）。 */
const POKE_RESP = message([]);

export interface SendPokeParams {
  /** true = 群聊戳一戳，false = 私聊戳一戳。 */
  isGroup: boolean;
  /** 群号（isGroup）或对方 uin（私聊）。 */
  peerUin: number;
  /** 要被戳的成员；群聊缺省戳群本身，私聊缺省戳对方。 */
  targetUin?: number;
}

export namespace SendPoke {
  export const command = 0xed3;
  export const subCommand = 1;
  export const reqSchema = POKE_REQ;
  export const respSchema = POKE_RESP;

  export type Params = SendPokeParams;

  /**
   * 组装 inner body。注意 proto3 默认值省略：groupUin/friendUin 的那个 0 不上
   * wire，与真机抓包一致（`ext` 也省略）。
   */
  export const serialize = (p: Params): Record<string, unknown> => ({
    uin: p.targetUin ?? p.peerUin,
    groupUin: p.isGroup ? p.peerUin : 0,
    friendUin: p.isGroup ? 0 : p.peerUin,
    ext: 0,
  });

  /** 空 ack，无字段可解。 */
  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SendPoke as OidbSpec<Params, void>, params);
}

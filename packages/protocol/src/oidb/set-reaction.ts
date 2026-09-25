// OIDB 0x9082 —— 群消息「贴表情」（表情回应）的设置 / 撤回。
//   subCommand 1 = 贴一个表情回应（set）
//   subCommand 2 = 撤回自己的表情回应（unset）
//
// 搬运自 SnowLuma `packages/protocol/src/oidb-services/reaction/set-reaction.ts`，
// 与 Lagrange.Core `SetGroupReactionRequest` / `AddGroupReactionService` 交叉核对：
//
//   f2 groupUin  (uint32)  群号
//   f3 sequence  (uint32)  被回应消息的 msgSeq
//   f4 code      (string)  表情 id
//   f5 type      (uint32)  1 = QQ 小黄脸短 id，2 = Unicode 码点
//   f6 field6    (bool)    Lagrange 会序列化成 false，这里照写
//   f7 field7    (bool)    同上
//
// ⚠️ 字段号是 2..7，不是 1..4：OIDB 信封的 body 本身占 1/2/3/4/5，inner body
// 从 2 起算。把 type 写到 f4 服务端会把 EmojiType 读成 0 并报
// "ReqBody.EmojiType: value must be greater than 0"。
//
// code 的形态沿用 Lagrange 的启发式：长度 > 3 视为 Unicode 码点（type=2），
// 否则视为 QQ 表情短 id（type=1）。比如 76/124 是小黄脸 id，128516 是 😄 的
// 码点。回包是空 ack（外层 errorCode=0，无 body）。
//
// 只做设置/撤回：查询某个表情的回应人列表（0x9083_1）与常用表情目录
// （0x9084_1）没有搬，按需再说。

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

/** 0x9082 的 inner body。 */
const REACTION_REQ = message([
  { name: 'groupUin', tag: 2, type: 'uint32' },
  { name: 'sequence', tag: 3, type: 'uint32' },
  { name: 'code', tag: 4, type: 'string' },
  { name: 'type', tag: 5, type: 'uint32' },
  { name: 'field6', tag: 6, type: 'bool', force: true },
  { name: 'field7', tag: 7, type: 'bool', force: true },
]);

/** 回包是空 ack。 */
const REACTION_RESP = message([]);

export interface SetReactionParams {
  /** 群号。 */
  groupId: number;
  /** 被回应消息的 msgSeq。 */
  sequence: number;
  /** 表情 id：1–3 位是 QQ 小黄脸 id，更长的是 Unicode 码点。 */
  code: string;
  /** true = 贴表情，false = 撤回自己的回应。 */
  isSet: boolean;
}

export namespace SetReaction {
  export const command = 0x9082;
  export const reqSchema = REACTION_REQ;
  export const respSchema = REACTION_RESP;

  export type Params = SetReactionParams;

  /** 1 = 设置，2 = 撤回。 */
  export const resolveSubCommand = (p: Params): number => (p.isSet ? 1 : 2);

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    if (!Number.isSafeInteger(p.sequence) || p.sequence <= 0) {
      throw new Error(`sequence 必须是正整数，收到 ${String(p.sequence)}`);
    }
    if (!p.code) throw new Error('code（表情 id）不能为空');
    return {
      groupUin: p.groupId,
      sequence: p.sequence,
      code: p.code,
      // Lagrange 的启发式：短 id 是 QQ 表情，长的是 Unicode 码点。
      type: p.code.length > 3 ? 2 : 1,
      field6: false,
      field7: false,
    };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetReaction as OidbSpec<Params, void>, params);
}

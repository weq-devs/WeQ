// 消息撤回（trpc.msg.msg_svc.MsgService）—— 群聊与私聊两条。
//
// 走的是 raw SSO 命令（不是 OIDB 信封）：
//   - 群聊 `trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg`
//   - 私聊 `trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg`
//
// 群聊请求：
//   f1 type      (uint32)  固定 1
//   f2 groupUin  (uint32)  群号
//   f3 info      { f1 sequence (uint32), f2 random (uint32), f3 field3 (uint32) }
//   f4 settings  { f1 field1 (uint32) }
//
// 私聊请求（比群聊多几个定位字段：c2c 消息由 (clientSeq, msgSeq, random, timestamp)
// 四元组标识）：
//   f1 type      (uint32)  固定 1
//   f3 targetUid (string)  对方 uid
//   f4 info      { f1 clientSequence, f2 random, f3 messageId (uint64),
//                  f4 timestamp, f5 field5, f6 messageSequence }
//   f5 settings  { f1 bool, f2 bool }
//   f6 field6    (bool)
//
// `messageId = (0x01000000 << 32) | random`（对齐 SnowLuma）。
//
// 搬运自 SnowLuma `core/src/bridge/apis/message.ts` 的 recallGroup / recallPrivate；
// 撤回自己与别人的消息都是这条命令（服务端按 2 分钟窗口 / 管理员权限判定）。
//
// 签名：LagrangeV2 白名单里只有 `trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg`，
// 所以群聊 needSign = false、私聊 needSign = true。

import { message } from '../protobuf';
import { invokeTrpc, type TrpcSpec } from '../oidb/invoke';
import type { TrpcNative } from '../transport';

// ───────────────────────── 群聊撤回 ─────────────────────────

const GROUP_RECALL_INFO = message([
  { name: 'sequence', tag: 1, type: 'uint32' },
  { name: 'random', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
]);
const GROUP_RECALL_SETTINGS = message([{ name: 'field1', tag: 1, type: 'uint32' }]);
const GROUP_RECALL_REQ = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'groupUin', tag: 2, type: 'uint32' },
  { name: 'info', tag: 3, type: GROUP_RECALL_INFO },
  { name: 'settings', tag: 4, type: GROUP_RECALL_SETTINGS },
]);
const GROUP_RECALL_RESP = message([]);

export interface RecallGroupParams {
  /** 群号。 */
  groupId: number;
  /** 被撤回消息的 msgSeq。 */
  sequence: number;
  /** 该消息的 wire 层 random；拿不到给 0。 */
  random?: number;
}

export namespace RecallGroup {
  export const cmd = 'trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg';
  export const needSign = false;
  export const reqSchema = GROUP_RECALL_REQ;
  export const respSchema = GROUP_RECALL_RESP;

  export type Params = RecallGroupParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    if (!Number.isSafeInteger(p.sequence) || p.sequence <= 0) {
      throw new Error(`sequence 必须是正整数，收到 ${String(p.sequence)}`);
    }
    return {
      type: 1,
      groupUin: p.groupId,
      info: { sequence: p.sequence, random: p.random ?? 0, field3: 0 },
      settings: { field1: 0 },
    };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: TrpcNative, pid: number, params: Params): Promise<void> =>
    invokeTrpc(nt, pid, RecallGroup as TrpcSpec<Params, void>, params);
}

// ───────────────────────── 私聊撤回 ─────────────────────────

const C2C_RECALL_INFO = message([
  { name: 'clientSequence', tag: 1, type: 'uint32' },
  { name: 'random', tag: 2, type: 'uint32' },
  { name: 'messageId', tag: 3, type: 'uint64' },
  { name: 'timestamp', tag: 4, type: 'uint32' },
  { name: 'field5', tag: 5, type: 'uint32' },
  { name: 'messageSequence', tag: 6, type: 'uint32' },
]);
const C2C_RECALL_SETTINGS = message([
  { name: 'field1', tag: 1, type: 'bool' },
  { name: 'field2', tag: 2, type: 'bool' },
]);
const C2C_RECALL_REQ = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'targetUid', tag: 3, type: 'string' },
  { name: 'info', tag: 4, type: C2C_RECALL_INFO },
  { name: 'settings', tag: 5, type: C2C_RECALL_SETTINGS },
  { name: 'field6', tag: 6, type: 'bool' },
]);
const C2C_RECALL_RESP = message([]);

export interface RecallPrivateParams {
  /** 对方 NT uid。 */
  targetUid: string;
  /** 消息的 clientSeq。 */
  clientSequence: number;
  /** 消息的 msgSeq。 */
  messageSequence: number;
  /** 该消息的 wire 层 random。 */
  random: number;
  /** 消息时间戳（unix 秒）。 */
  timestamp: number;
}

/** `messageId` 的构造常量（对齐 SnowLuma）。 */
const C2C_MESSAGE_ID_HIGH = 0x01000000n << 32n;

export namespace RecallPrivate {
  export const cmd = 'trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg';
  export const needSign = true;
  export const reqSchema = C2C_RECALL_REQ;
  export const respSchema = C2C_RECALL_RESP;

  export type Params = RecallPrivateParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!p.targetUid) throw new Error('targetUid 不能为空');
    const random = p.random >>> 0;
    return {
      type: 1,
      targetUid: p.targetUid,
      info: {
        clientSequence: p.clientSequence,
        random,
        messageId: C2C_MESSAGE_ID_HIGH | BigInt(random),
        timestamp: p.timestamp,
        field5: 0,
        messageSequence: p.messageSequence,
      },
      settings: { field1: false, field2: false },
      field6: false,
    };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: TrpcNative, pid: number, params: Params): Promise<void> =>
    invokeTrpc(nt, pid, RecallPrivate as TrpcSpec<Params, void>, params);
}

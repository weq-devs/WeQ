/**
 * 获取合并转发（长消息）内容 —— trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg。
 *
 * 抄自 SnowLuma `packages/proto-defs/src/longmsg.ts` 的 schema +
 * `packages/core/src/bridge/apis/forward.ts` 的 fetch 分支：
 *   - 请求 RecvLongMsgReq{ info{ uid{ uid=自己uid }, resId, acquire=true }, settings{ 2,0,0,0 } }
 *   - 响应 RecvLongMsgResp{ result{ resId, payload } }，payload 是 gzip 压缩的
 *     LongMsgResult；其中 actionCommand == 'MultiMsg' 的 action 的
 *     actionData.msgBody 就是合并转发里的消息列表（每一条都是 PushMsgBody）。
 *
 * 与 get-history 一样走原生 `sendPacket`（原始 SSO 通道，无 OIDB 信封），
 * 这里额外返回原始响应 / 压缩 payload / 解压后的 LongMsgResult / 第一条消息的
 * 原始字节，方便做 hex / tag:value 全字段分析。
 */

import { gunzipSync } from 'node:zlib';
import { decode, encode, message, type ProtoMessage } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';
import { invokeTrpc, type TrpcSpec } from '../oidb/invoke';
import { PUSH_MSG_BODY } from './schemas';
import { extractPath } from './dump';

export const SSO_RECV_LONG_MSG_CMD = 'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg';

// ---------- 请求 / 响应 schema（抄自 SnowLuma longmsg.ts） ----------

/** RecvLongMsgReq.info.uid —— 自己账号的长 uid。 */
export const LONG_MSG_UID: ProtoMessage = message([{ name: 'uid', tag: 2, type: 'string' }]);

/** 请求/响应里都带的 settings（field1..field4 语义未公开，照抄 SnowLuma）。 */
export const LONG_MSG_SETTINGS: ProtoMessage = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'field4', tag: 4, type: 'uint32' },
]);

export const RECV_LONG_MSG_INFO: ProtoMessage = message([
  { name: 'uid', tag: 1, type: LONG_MSG_UID },
  { name: 'resId', tag: 2, type: 'string' },
  { name: 'acquire', tag: 3, type: 'bool' },
]);

export const RECV_LONG_MSG_REQ: ProtoMessage = message([
  { name: 'info', tag: 1, type: RECV_LONG_MSG_INFO },
  { name: 'settings', tag: 15, type: LONG_MSG_SETTINGS },
]);

export const RECV_LONG_MSG_RESP_RESULT: ProtoMessage = message([
  { name: 'resId', tag: 3, type: 'string' },
  { name: 'payload', tag: 4, type: 'bytes' },
]);

export const RECV_LONG_MSG_RESP: ProtoMessage = message([
  { name: 'result', tag: 1, type: RECV_LONG_MSG_RESP_RESULT },
  { name: 'settings', tag: 15, type: LONG_MSG_SETTINGS },
]);

/** 解压后的 LongMsgResult：'MultiMsg' action 的 actionData.msgBody 即转发消息。 */
export const LONG_MSG_CONTENT: ProtoMessage = message([
  { name: 'msgBody', tag: 1, type: PUSH_MSG_BODY, repeated: true },
]);

export const LONG_MSG_ACTION: ProtoMessage = message([
  { name: 'actionCommand', tag: 1, type: 'string' },
  { name: 'actionData', tag: 2, type: LONG_MSG_CONTENT },
]);

export const LONG_MSG_RESULT: ProtoMessage = message([
  { name: 'action', tag: 2, type: LONG_MSG_ACTION, repeated: true },
]);

// ---------- 公共参数 / 返回结构 ----------

export interface RecvLongMsgParams {
  /** 自己账号的长 uid（RecvLongMsgReq.info.uid.uid）。 */
  selfUid: string;
  /** 合并转发的 resId（通常来自 multiMsg 元素的 resId / 转发卡片）。 */
  resId: string;
  /** 可选覆盖 settings 的 4 个 uint32；默认 {2,0,0,0}（与 SnowLuma fetch 分支一致）。 */
  settings?: { field1?: number; field2?: number; field3?: number; field4?: number };
}

/** 拉取长消息默认 settings（SnowLuma fetch 分支原样）。 */
const DEFAULT_RECV_SETTINGS = { field1: 2, field2: 0, field3: 0, field4: 0 };

export interface ForwardFetchResult {
  /** 命令字。 */
  cmd: string;
  /** 请求的 resId。 */
  resId: string;
  /** 原始响应字节（RecvLongMsgResp，未做任何截断）。 */
  rawResponse: Uint8Array;
  /** 按 schema 解码出的响应。 */
  decodedResponse: Record<string, unknown>;
  /** 压缩 payload（result.payload），缺失时为 null。 */
  payload: Uint8Array | null;
  /** gunzip 解压后的 LongMsgResult 原始字节，解压失败时为 null。 */
  inflated: Uint8Array | null;
  /** 按 schema 解码出的 LongMsgResult，解压/解码失败时为 null。 */
  longMsg: Record<string, unknown> | null;
  /** longMsg.action 列表（含 'MultiMsg' 与内层 uuid 条目）。 */
  actions: Record<string, unknown>[];
  /** 'MultiMsg' action 的 actionData.msgBody（合并转发里的消息列表）。 */
  messages: Record<string, unknown>[];
  /** 第一条转发消息的原始字节（方便 hex / 全字段分析），无消息时为 null。 */
  firstMessageBytes: Uint8Array | null;
  /** payload 缺失 / 解压 / LongMsgResult 解码失败时的错误说明，全部成功时为 undefined。 */
  error?: string;
}

// ---------- 合并转发 ----------

export namespace RecvLongMsg {
  export const cmd = SSO_RECV_LONG_MSG_CMD;
  export const reqSchema = RECV_LONG_MSG_REQ;
  export const respSchema = RECV_LONG_MSG_RESP;

  export const serialize = (p: RecvLongMsgParams): Record<string, unknown> => ({
    info: { uid: { uid: p.selfUid }, resId: p.resId, acquire: true },
    settings: p.settings ?? DEFAULT_RECV_SETTINGS,
  });

  /** 返回顶层 { result: { resId, payload }, settings } 的原样解码结果。 */
  export const deserialize = (body: Record<string, unknown>): Record<string, unknown> => body;

  export const invoke = (
    nt: TrpcNative,
    pid: number,
    params: RecvLongMsgParams,
  ): Promise<Record<string, unknown>> =>
    invokeTrpc(
      nt,
      pid,
      RecvLongMsg as TrpcSpec<RecvLongMsgParams, Record<string, unknown>>,
      params,
    );
}

/** 按 resId 拉取合并转发内容，返回原始响应 + 解压后的 LongMsgResult + 第一条消息原始字节。 */
export async function fetchForwardRaw(
  nt: TrpcNative,
  pid: number,
  params: RecvLongMsgParams,
): Promise<ForwardFetchResult> {
  if (!params.selfUid.trim()) throw new Error('selfUid 不能为空');
  if (!params.resId.trim()) throw new Error('resId 不能为空');

  const reqBytes = encode(RECV_LONG_MSG_REQ, RecvLongMsg.serialize(params));
  const rawResponse = await sendPacket(nt, pid, SSO_RECV_LONG_MSG_CMD, reqBytes);
  const decodedResponse = decode(RECV_LONG_MSG_RESP, rawResponse) as Record<string, unknown>;

  const result = decodedResponse.result as { resId?: string; payload?: Uint8Array } | undefined;
  const payload =
    result?.payload instanceof Uint8Array && result.payload.length > 0 ? result.payload : null;
  if (!payload) {
    return {
      cmd: SSO_RECV_LONG_MSG_CMD,
      resId: params.resId,
      rawResponse,
      decodedResponse,
      payload: null,
      inflated: null,
      longMsg: null,
      actions: [],
      messages: [],
      firstMessageBytes: null,
      error: '响应里没有 payload（result.payload 为空）',
    };
  }

  let inflated: Uint8Array;
  try {
    // 32 MiB 上限：转发内容再大也不至于撑爆堆，同时挡住压缩炸弹。
    inflated = gunzipSync(Buffer.from(payload), { maxOutputLength: 32 * 1024 * 1024 });
  } catch (cause) {
    return {
      cmd: SSO_RECV_LONG_MSG_CMD,
      resId: params.resId,
      rawResponse,
      decodedResponse,
      payload,
      inflated: null,
      longMsg: null,
      actions: [],
      messages: [],
      firstMessageBytes: null,
      error: `payload 解压失败: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  try {
    const longMsg = decode(LONG_MSG_RESULT, inflated) as Record<string, unknown>;
    const actions = Array.isArray(longMsg.action)
      ? (longMsg.action as Record<string, unknown>[])
      : [];
    const multiMsgIndex = actions.findIndex(
      (a) => (a as { actionCommand?: string }).actionCommand === 'MultiMsg',
    );
    const mainAction = multiMsgIndex >= 0 ? actions[multiMsgIndex] : undefined;
    const actionData = (mainAction as { actionData?: { msgBody?: unknown[] } } | undefined)
      ?.actionData;
    const messages = Array.isArray(actionData?.msgBody)
      ? (actionData.msgBody as Record<string, unknown>[])
      : [];
    const firstMessageBytes =
      multiMsgIndex >= 0 && messages.length > 0
        ? extractPath(inflated, [
            { tag: 2, index: multiMsgIndex },
            { tag: 2 },
            { tag: 1, index: 0 },
          ])
        : null;
    return {
      cmd: SSO_RECV_LONG_MSG_CMD,
      resId: params.resId,
      rawResponse,
      decodedResponse,
      payload,
      inflated,
      longMsg,
      actions,
      messages,
      firstMessageBytes,
    };
  } catch (cause) {
    return {
      cmd: SSO_RECV_LONG_MSG_CMD,
      resId: params.resId,
      rawResponse,
      decodedResponse,
      payload,
      inflated,
      longMsg: null,
      actions: [],
      messages: [],
      firstMessageBytes: null,
      error: `LongMsgResult 解码失败: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

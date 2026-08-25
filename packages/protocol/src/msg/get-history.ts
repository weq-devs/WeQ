/**
 * 主动拉取历史消息（按 seq 范围）—— trpc.msg.register_proxy 系的 SSO 命令。
 *
 *   - 群聊：  SsoGetGroupMsg，按 [startSeq, endSeq] 窗口拉取。
 *   - 私聊：  SsoGetC2cMsg，按会话级 NT sequence 窗口拉取（friendUid 是 UID）。
 *
 * 与 SnowLuma 一样走原生 `sendPacket`（原始 SSO 通道，无 OIDB 信封），但这里
 * 额外返回原始响应字节 + 第一条消息的原始字节，方便做全字段 hex/tag:value 分析。
 */

import { decode, encode, message, type ProtoMessage } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';
import { invokeTrpc, type TrpcSpec } from '../oidb/invoke';
import { PUSH_MSG_BODY } from './schemas';
import { extractPath } from './dump';

export const SSO_GET_GROUP_MSG_CMD = 'trpc.msg.register_proxy.RegisterProxy.SsoGetGroupMsg';
export const SSO_GET_C2C_MSG_CMD = 'trpc.msg.register_proxy.RegisterProxy.SsoGetC2cMsg';

// ---------- 请求 / 响应 schema ----------

const SSO_GET_GROUP_MSG_REQUEST: ProtoMessage = message([
  {
    name: 'info',
    tag: 1,
    type: message([
      { name: 'groupUin', tag: 1, type: 'uint32' },
      { name: 'startSequence', tag: 2, type: 'uint32' },
      { name: 'endSequence', tag: 3, type: 'uint32' },
    ]),
  },
  { name: 'direction', tag: 2, type: 'bool' },
]);

const SSO_GET_GROUP_MSG_RESPONSE: ProtoMessage = message([
  {
    name: 'body',
    tag: 3,
    type: message([
      { name: 'groupUin', tag: 3, type: 'uint32' },
      { name: 'startSequence', tag: 4, type: 'uint32' },
      { name: 'endSequence', tag: 5, type: 'uint32' },
      { name: 'messages', tag: 6, type: PUSH_MSG_BODY, repeated: true },
    ]),
  },
]);

const SSO_GET_C2C_MSG_REQUEST: ProtoMessage = message([
  { name: 'friendUid', tag: 2, type: 'string' },
  { name: 'startSequence', tag: 3, type: 'uint32' },
  { name: 'endSequence', tag: 4, type: 'uint32' },
]);

const SSO_GET_C2C_MSG_RESPONSE: ProtoMessage = message([
  { name: 'friendUid', tag: 4, type: 'string' },
  { name: 'messages', tag: 7, type: PUSH_MSG_BODY, repeated: true },
]);

// ---------- 公共返回结构 ----------

export interface HistoryFetchResult {
  /** 命令字。 */
  cmd: string;
  /** 原始响应字节（未做任何截断）。 */
  rawResponse: Uint8Array;
  /** 按 schema 解码出的消息列表。 */
  messages: Record<string, unknown>[];
  /** 第一条消息的原始字节（方便 hex / 全字段分析），无消息时为 null。 */
  firstMessageBytes: Uint8Array | null;
  /** 响应携带的会话信息（groupUin / friendUid）。 */
  peer: { groupUin?: number; friendUid?: string };
  /** 请求的 seq 窗口。 */
  range: { startSeq: number; endSeq: number };
}

// ---------- 群聊历史 ----------

export interface GroupHistoryParams {
  groupUin: number;
  startSeq: number;
  endSeq: number;
}

export namespace GetGroupHistory {
  export const cmd = SSO_GET_GROUP_MSG_CMD;
  export const reqSchema = SSO_GET_GROUP_MSG_REQUEST;
  export const respSchema = SSO_GET_GROUP_MSG_RESPONSE;

  export const serialize = (p: GroupHistoryParams): Record<string, unknown> => ({
    info: { groupUin: p.groupUin, startSequence: p.startSeq, endSequence: p.endSeq },
    direction: true,
  });

  /** 返回顶层 { body: { messages: [...] } } 的原样解码结果。 */
  export const deserialize = (body: Record<string, unknown>): Record<string, unknown> => body;

  export const invoke = (
    nt: TrpcNative,
    pid: number,
    params: GroupHistoryParams,
  ): Promise<Record<string, unknown>> =>
    invokeTrpc(nt, pid, GetGroupHistory as TrpcSpec<GroupHistoryParams, Record<string, unknown>>, params);
}

/** 群聊：按 seq 范围拉取，返回原始响应 + 第一条消息原始字节。 */
export async function fetchGroupHistoryRaw(
  nt: TrpcNative,
  pid: number,
  params: GroupHistoryParams,
): Promise<HistoryFetchResult> {
  if (!Number.isSafeInteger(params.groupUin) || params.groupUin <= 0) {
    throw new Error(`groupUin 非法: ${String(params.groupUin)}`);
  }
  if (!Number.isSafeInteger(params.startSeq) || !Number.isSafeInteger(params.endSeq)
    || params.startSeq > params.endSeq || params.endSeq < 0) {
    throw new Error(`seq 窗口非法: ${params.startSeq}-${params.endSeq}`);
  }

  const reqBytes = encode(SSO_GET_GROUP_MSG_REQUEST, GetGroupHistory.serialize(params));
  const rawResponse = await sendPacket(nt, pid, SSO_GET_GROUP_MSG_CMD, reqBytes);
  const decoded = decode(SSO_GET_GROUP_MSG_RESPONSE, rawResponse) as {
    body?: { groupUin?: number; startSequence?: number; endSequence?: number; messages?: unknown[] };
  };
  const body = decoded.body ?? {};
  const messages = Array.isArray(body.messages) ? body.messages as Record<string, unknown>[] : [];
  const firstMessageBytes = extractPath(rawResponse, [{ tag: 3 }, { tag: 6, index: 0 }]);
  return {
    cmd: SSO_GET_GROUP_MSG_CMD,
    rawResponse,
    messages,
    firstMessageBytes,
    peer: { groupUin: body.groupUin },
    range: { startSeq: params.startSeq, endSeq: params.endSeq },
  };
}

// ---------- 私聊历史 ----------

export interface C2cHistoryParams {
  friendUid: string;
  startSeq: number;
  endSeq: number;
}

export namespace GetC2cHistory {
  export const cmd = SSO_GET_C2C_MSG_CMD;
  export const reqSchema = SSO_GET_C2C_MSG_REQUEST;
  export const respSchema = SSO_GET_C2C_MSG_RESPONSE;

  export const serialize = (p: C2cHistoryParams): Record<string, unknown> => ({
    friendUid: p.friendUid,
    startSequence: p.startSeq,
    endSequence: p.endSeq,
  });

  /** 返回顶层 { friendUid, messages: [...] } 的原样解码结果。 */
  export const deserialize = (body: Record<string, unknown>): Record<string, unknown> => body;

  export const invoke = (
    nt: TrpcNative,
    pid: number,
    params: C2cHistoryParams,
  ): Promise<Record<string, unknown>> =>
    invokeTrpc(nt, pid, GetC2cHistory as TrpcSpec<C2cHistoryParams, Record<string, unknown>>, params);
}

/** 私聊：按会话级 NT sequence 范围拉取，返回原始响应 + 第一条消息原始字节。 */
export async function fetchC2cHistoryRaw(
  nt: TrpcNative,
  pid: number,
  params: C2cHistoryParams,
): Promise<HistoryFetchResult> {
  if (!params.friendUid.trim()) throw new Error('friendUid 不能为空');
  if (!Number.isSafeInteger(params.startSeq) || !Number.isSafeInteger(params.endSeq)
    || params.startSeq > params.endSeq || params.endSeq < 0) {
    throw new Error(`seq 窗口非法: ${params.startSeq}-${params.endSeq}`);
  }

  const reqBytes = encode(SSO_GET_C2C_MSG_REQUEST, GetC2cHistory.serialize(params));
  const rawResponse = await sendPacket(nt, pid, SSO_GET_C2C_MSG_CMD, reqBytes);
  const decoded = decode(SSO_GET_C2C_MSG_RESPONSE, rawResponse) as {
    friendUid?: string;
    messages?: unknown[];
  };
  const messages = Array.isArray(decoded.messages) ? decoded.messages as Record<string, unknown>[] : [];
  const firstMessageBytes = extractPath(rawResponse, [{ tag: 7, index: 0 }]);
  return {
    cmd: SSO_GET_C2C_MSG_CMD,
    rawResponse,
    messages,
    firstMessageBytes,
    peer: { friendUid: decoded.friendUid },
    range: { startSeq: params.startSeq, endSeq: params.endSeq },
  };
}

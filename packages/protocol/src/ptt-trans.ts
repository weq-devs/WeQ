/**
 * 语音在线转文字（pttTrans）—— 裸 SSO 命令，不经 OIDB 信封。
 *
 * 两个命令：
 *   - `pttTrans.TransC2CPttReq`  （type=2，c2cItem）
 *   - `pttTrans.TransGroupPttReq`（type=1，groupItem）
 *
 * ⚠️ 这是**异步**接口：发包只回一个 ack（`errCode === 0` 表示已受理），真正的
 * 转写文本随后由 `trpc.msg.olpush.OlPushService.MsgPush` 主动推送 —— 一条
 * `contentHead.msgType = 528 (0x210)` / `subType = 61` 的 push，`MsgBody.msgContent`
 * 里就是一个 {@link PTT_TRANS_PUSH}。push 里的 `item.msgId` **就是请求里的 msgId**，
 * 所以并发发多条请求时按 msgId 归集即可。
 *
 * 本模块只做 (de)serialize + 请求构造 + push 解析；「发请求 → 抓 push」的编排在
 * 上层（app 主进程），因为它要同时用到 native 发包与网卡旁路抓包。
 *
 * 字段布局对齐 SnowLuma `packages/proto-defs/src/ptt-trans.ts`，并被
 * `~/Downloads/{c2cptt,groupptt}.log` 的抓包逐字节验证（见单测）。
 */

import { decode, encode, message, type ProtoMessage } from './protobuf';
import { invokeTrpc, type TrpcSpec } from './oidb/invoke';
import { sendPacket, type TrpcNative } from './transport';
import { PUSH_MSG, PUSH_MSG_BODY, CONTENT_HEAD } from './msg/schemas';

/** `pttTrans.TransC2CPttReq`。 */
export const C2C_PTT_TRANS_CMD = 'pttTrans.TransC2CPttReq';
/** `pttTrans.TransGroupPttReq`。 */
export const GROUP_PTT_TRANS_CMD = 'pttTrans.TransGroupPttReq';

/** push 的 `contentHead.msgType`（0x210 = 528）。 */
export const PTT_TRANS_PUSH_MSG_TYPE = 528;
/** push 的 `contentHead.subType`（61）。 */
export const PTT_TRANS_PUSH_SUB_TYPE = 61;

const f = (
  name: string,
  tag: number,
  type: ProtoMessage['fields'][number]['type'],
  extra: Partial<{ repeated: boolean; force: boolean }> = {},
) => ({ name, tag, type, ...extra });

// ─────────────────────────── request ───────────────────────────

/**
 * 私聊（c2c）转写项。`md5` 是**32 字符小写 hex 字符串**（不是裸 16 字节 ——
 * 发裸字节服务端回 -1079）。
 */
export const C2C_PTT_TRANS_ITEM: ProtoMessage = message([
  f('msgId', 1, 'uint64', { force: true }),
  f('senderUin', 2, 'uint64', { force: true }),
  f('receiverUin', 3, 'uint64', { force: true }),
  f('uuid', 4, 'string'),
  f('duration', 5, 'uint32', { force: true }),
  f('size', 6, 'uint32', { force: true }),
  f('format', 7, 'uint32', { force: true }),
  f('eventType', 8, 'uint32', { force: true }),
  f('md5', 9, 'string'),
]);

/** 群聊转写项。同样 `md5` 为 32 字符小写 hex 字符串。 */
export const GROUP_PTT_TRANS_ITEM: ProtoMessage = message([
  f('msgId', 1, 'uint64', { force: true }),
  f('senderUin', 2, 'uint64', { force: true }),
  f('groupUin', 3, 'uint64', { force: true }),
  f('fileId', 4, 'uint32', { force: true }),
  f('md5', 5, 'string'),
  f('duration', 6, 'uint32', { force: true }),
  f('size', 7, 'uint32', { force: true }),
  f('format', 8, 'uint32', { force: true }),
  f('uuid', 9, 'string'),
  f('eventType', 10, 'uint32', { force: true }),
  f('extra', 11, 'bytes'),
]);

/**
 * `PttTransReq`：`type` 1=群、2=私聊；只有对应的 item 会被填。
 *
 * `flag5` / `flag6`（实测恒为 1）与 `flag10`（恒为 0）是外层多出来的常量字段 ——
 * QQ 的 wrapper 会显式写它们，抓包逐字节比对要求我们也照写（`force`）。
 */
export const PTT_TRANS_REQ: ProtoMessage = message([
  f('type', 1, 'uint32', { force: true }),
  f('groupItem', 2, GROUP_PTT_TRANS_ITEM),
  f('c2cItem', 3, C2C_PTT_TRANS_ITEM),
  f('flag5', 5, 'uint32', { force: true }),
  f('flag6', 6, 'uint32', { force: true }),
  f('flag10', 10, 'uint32', { force: true }),
]);

// ─────────────────────────── response ───────────────────────────

/**
 * 同步响应里的结果项。**只解出 msgId + errCode** —— 文本永远走 push，同步响应
 * 里剩下的字段（uuid/md5/常量）我们不需要，多定义的字段反而会因为 tag 类型
 * 在不同场景下不一致（c2c 的 uuid 在 tag 6、群的 md5 在 tag 7）而解错。
 */
export const PTT_TRANS_RESULT: ProtoMessage = message([
  f('msgId', 1, 'uint64'),
  f('errCode', 2, 'int32'),
  f('field3', 3, 'uint32'),
]);

export const PTT_TRANS_RESP: ProtoMessage = message([
  f('type', 1, 'uint32'),
  f('groupResult', 2, PTT_TRANS_RESULT),
  f('c2cResult', 3, PTT_TRANS_RESULT),
]);

// ─────────────────────────── push ───────────────────────────

/**
 * push 里的转写项。
 *
 * 实测：私聊 push 把 `uuid`（=请求里的 fileToken）放在 tag 13；群 push 把
 * 请求里的 `md5`（大写化）放在 tag 12。两者都不参与匹配 —— 归集只认
 * `msgId`，`uuid`/`md5` 仅作诊断。
 */
export const PTT_TRANS_PUSH_ITEM: ProtoMessage = message([
  f('msgId', 1, 'uint64'),
  f('scene', 2, 'uint32'),
  f('field3', 3, 'uint32'),
  f('field4', 4, 'uint32'),
  f('field5', 5, 'uint32'),
  f('field6', 6, 'uint32'),
  f('field7', 7, 'uint32'),
  f('text', 8, 'string'),
  f('senderUin', 9, 'uint64'),
  f('receiverUin', 10, 'uint64'),
  f('field11', 11, 'uint32'),
  f('uuidGroup', 12, 'string'),
  f('uuidC2c', 13, 'string'),
]);

/** `MsgBody.msgContent`（tag 2）里的 push 载荷。 */
export const PTT_TRANS_PUSH: ProtoMessage = message([
  f('field1', 1, 'uint32'),
  f('item', 2, PTT_TRANS_PUSH_ITEM),
]);

// ─────────────────────────── 输入 / 输出 ───────────────────────────

/** 一条待转写的语音（来自媒体扫描的 ptt 引用 + 消息上下文）。 */
export interface PttTransVoice {
  isGroup: boolean;
  /** 消息 id（u64，十进制字符串或 bigint 均可）。 */
  msgId: string | bigint;
  /** 发送者 uin。 */
  senderUin: string | bigint;
  /** 私聊 = 对方 uin；群聊 = 群号。 */
  peerUin: string | bigint;
  /** CDN download token（=fileToken，请求里的 uuid）。 */
  uuid: string;
  /** 32 字符小写 hex md5 字符串。 */
  md5: string;
  /** 时长（秒）。 */
  duration: number;
  /** 字节数。 */
  size: number;
  /** 编码格式（实测 1）。 */
  format: number;
  /** 事件类型（实测 0）。 */
  eventType?: number;
  /** 群语音的数值 file id（可选）。 */
  fileId?: number;
  /** 群语音的透传扩展（可选）。 */
  extra?: Uint8Array;
}

/** 构造 `PttTransReq` 的明文对象（给 `encode(PTT_TRANS_REQ, …)` 用）。 */
export function buildPttTransReq(v: PttTransVoice): Record<string, unknown> {
  if (v.isGroup) {
    return {
      type: 1,
      flag5: 1,
      flag6: 1,
      flag10: 0,
      groupItem: {
        msgId: typeof v.msgId === 'string' ? BigInt(v.msgId) : v.msgId,
        senderUin: typeof v.senderUin === 'string' ? BigInt(v.senderUin) : v.senderUin,
        groupUin: typeof v.peerUin === 'string' ? BigInt(v.peerUin) : v.peerUin,
        fileId: v.fileId ?? 0,
        md5: v.md5.toLowerCase(),
        duration: v.duration,
        size: v.size,
        format: v.format,
        uuid: v.uuid,
        eventType: v.eventType ?? 0,
        ...(v.extra ? { extra: v.extra } : {}),
      },
    };
  }
  return {
    type: 2,
    flag5: 1,
    flag6: 1,
    flag10: 0,
    c2cItem: {
      msgId: typeof v.msgId === 'string' ? BigInt(v.msgId) : v.msgId,
      senderUin: typeof v.senderUin === 'string' ? BigInt(v.senderUin) : v.senderUin,
      receiverUin: typeof v.peerUin === 'string' ? BigInt(v.peerUin) : v.peerUin,
      uuid: v.uuid,
      duration: v.duration,
      size: v.size,
      format: v.format,
      eventType: v.eventType ?? 0,
      md5: v.md5.toLowerCase(),
    },
  };
}

/** 命令名（按是否群聊选）。 */
export function pttTransCmd(isGroup: boolean): string {
  return isGroup ? GROUP_PTT_TRANS_CMD : C2C_PTT_TRANS_CMD;
}

/** 编码 `PttTransReq`。 */
export function encodePttTransReq(v: PttTransVoice): Uint8Array {
  return encode(PTT_TRANS_REQ, buildPttTransReq(v));
}

/** 同步响应的解析结果。 */
export interface PttTransAck {
  /** 目标 msgId（回包原样带回）。 */
  msgId: bigint;
  /** 0 = 已受理（文本稍后 push）；非 0 = 失败（如过期），可直接回退本地模型。 */
  errCode: number;
}

/** 解析同步响应体；解不出结果时返回 null。 */
export function parsePttTransAck(body: Uint8Array, isGroup: boolean): PttTransAck | null {
  const resp = decode(PTT_TRANS_RESP, body) as {
    groupResult?: { msgId?: bigint; errCode?: number };
    c2cResult?: { msgId?: bigint; errCode?: number };
  };
  const item = isGroup ? resp.groupResult : resp.c2cResult;
  if (!item) return null;
  return { msgId: item.msgId ?? 0n, errCode: item.errCode ?? 0 };
}

/** 从 push 里解出的转写结果。 */
export interface PttTransPush {
  /** 与请求 msgId 相同 —— 并发归集的唯一键。 */
  msgId: bigint;
  /** 转写文本（可能为空串：服务端识别为空）。 */
  text: string;
  senderUin: bigint;
  receiverUin: bigint;
  /** 私聊 push 的 uuid / 群 push 的 md5（诊断用，可能为空）。 */
  uuid: string;
}

/**
 * 判断一条解密后的 MsgPush 帧体是否是语音转写 push（`msgType=528` /
 * `subType=61`），是则解出 {@link PttTransPush}，否则返回 null。
 *
 * 传进来的应当是**整段命令体**（`trpc.msg.olpush.OlPushService.MsgPush` 的
 * body），即 `PUSH_MSG` 的外层；兼容直接传 `PUSH_MSG_BODY` 的场景。
 */
export function parsePttTransPush(body: Uint8Array): PttTransPush | null {
  const outer = decode(PUSH_MSG, body) as {
    message?: Record<string, unknown>;
  };
  const inner = (outer.message ?? decode(PUSH_MSG_BODY, body)) as {
    contentHead?: { msgType?: number; subType?: number };
    body?: { msgContent?: Uint8Array };
  };
  const head = inner.contentHead;
  if (!head) return null;
  if (head.msgType !== PTT_TRANS_PUSH_MSG_TYPE || head.subType !== PTT_TRANS_PUSH_SUB_TYPE) {
    return null;
  }
  const content = inner.body?.msgContent;
  if (!content || content.length === 0) return null;
  const push = decode(PTT_TRANS_PUSH, content) as {
    item?: {
      msgId?: bigint;
      text?: string;
      senderUin?: bigint;
      receiverUin?: bigint;
      uuidGroup?: string;
      uuidC2c?: string;
    };
  };
  const item = push.item;
  if (!item) return null;
  return {
    msgId: item.msgId ?? 0n,
    text: item.text ?? '',
    senderUin: item.senderUin ?? 0n,
    receiverUin: item.receiverUin ?? 0n,
    uuid: item.uuidC2c || item.uuidGroup || '',
  };
}

// ─────────────────────────── invoke（发请求） ───────────────────────────

export namespace PttTrans {
  export const needSign = false;
  export const reqSchema = PTT_TRANS_REQ;
  export const respSchema = PTT_TRANS_RESP;

  /**
   * 发一条转写请求，返回同步 ack。文本走 push（见 {@link parsePttTransPush}）。
   */
  export async function send(
    nt: TrpcNative,
    pid: number,
    voice: PttTransVoice,
  ): Promise<PttTransAck | null> {
    const cmd = pttTransCmd(voice.isGroup);
    const respBytes = await sendPacket(nt, pid, cmd, encodePttTransReq(voice), needSign);
    return parsePttTransAck(respBytes, voice.isGroup);
  }

  export const serialize = (v: PttTransVoice): Record<string, unknown> => buildPttTransReq(v);
  export const deserialize = (
    body: Record<string, unknown>,
    v: PttTransVoice,
  ): PttTransAck | null => {
    const item = (v.isGroup ? body.groupResult : body.c2cResult) as
      | { msgId?: bigint; errCode?: number }
      | undefined;
    if (!item) return null;
    return { msgId: item.msgId ?? 0n, errCode: item.errCode ?? 0 };
  };

  export const invoke = (
    nt: TrpcNative,
    pid: number,
    voice: PttTransVoice,
  ): Promise<PttTransAck | null> =>
    invokeTrpc(
      nt,
      pid,
      {
        cmd: pttTransCmd(voice.isGroup),
        needSign,
        reqSchema,
        respSchema,
        serialize,
        deserialize: (body) => deserialize(body, voice),
      } as TrpcSpec<PttTransVoice, PttTransAck | null>,
      voice,
    );
}

export { CONTENT_HEAD };

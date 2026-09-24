/**
 * 发消息 —— `MessageSvc.PbSendMsg`（原始 SSO 命令，无 OIDB 信封）。
 *
 * 三个场景共用同一条命令，只差 routingHead / contentHead：
 *   群聊       routingHead.grp.groupCode      + contentHead { type: 1 }
 *   私聊       routingHead.c2c.{uin,uid}      + contentHead { type:1, c2cCmd:11 } + ctrl.msgFlag
 *   群临时会话 routingHead.grpTmp{groupUin,toUid} + contentHead { type:1, c2cCmd:11 } + ctrl.msgFlag
 * （对照 SnowLuma `packages/core/src/bridge/apis/message.ts` 的 sendGroup /
 * sendPrivate / sendGroupTempMessage。）
 *
 * 元素打包在 `./send-elements`（与收侧 `./decode` 共用同一份 ELEM schema），本文件
 * 只做路由、random/sequence、响应解析与回执。
 *
 * 图片/语音/视频先上传（NTV2 + highway，见 `../highway/media-upload`）再发：
 * {@link sendMessage} 收 `params.media`（nt/pid/uin），上传产物直接成为
 * `commonElem(serviceType=48).pbElem`；场景与目标从 routing 参数推导，不会错配。
 *
 * **失败不静默**：`result != 0` 或响应体为空时返回 `ok: false` 并带上 errMsg，
 * 调用方必须检查 {@link isSendOk} —— 不要把「没有抛异常」当成发送成功。
 */

import { randomInt } from 'node:crypto';
import type { MediaNative } from '../highway/ntv2-upload';
import { decode, encode } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';
import { invokeTrpc, type TrpcSpec } from '../oidb/invoke';
import { toInt } from '../oidb/shared';
import { SEND_MESSAGE_REQUEST, SEND_MESSAGE_RESPONSE } from './send-schemas';
import {
  buildSendElems,
  buildSendElemsWithMedia,
  isSendMediaElement,
  type MediaSendContext,
  type SendElement,
  type SendMediaUploadReport,
  type SendScene,
} from './send-elements';

export const SEND_MSG_CMD = 'MessageSvc.PbSendMsg';

/** 群临时会话目标：源群号 + 对端 uid。 */
export interface SendGroupTempTarget {
  groupUin: number;
  toUid: string;
}

export interface SendMessageParams {
  /** 群聊目标群号（与 userUin / groupTemp 三选一）。 */
  groupId?: number;
  /** 私聊目标 QQ 号（与 groupId / groupTemp 三选一）。 */
  userUin?: number;
  /** 私聊目标 uid；带上则一并写进 routingHead.c2c.uid（媒体消息必需）。 */
  userUid?: string;
  /** 群临时会话目标（与 groupId / userUin 三选一）。 */
  groupTemp?: SendGroupTempTarget;
  /** 消息内容（至少一个元素）。 */
  elements: SendElement[];
  /** 客户端随机数（去重 / 回执用）；缺省随机生成。 */
  random?: number;
  /** 客户端序号；缺省群聊 0、私聊/临时会话自增。 */
  clientSequence?: number;
  /** 覆盖 ctrl.msgFlag（Unix 秒）；缺省当前时间（只有私聊/临时会话带 ctrl）。 */
  msgFlag?: number;
  /** 发送场景覆盖（窗口抖动等场景受限元素会用到）；缺省按 routing 推导。 */
  scene?: SendScene;
  /**
   * 媒体上传上下文（元素里含 image / record / video 时必填）。
   *
   * 只给「上传必需的」三样：native 绑定 + 进程 id + 自己 uin；场景 / 群号 /
   * 对方 uid 由 routing 参数推导（所以不会有「route 走群、上传走私聊」这种错配）。
   */
  media?: {
    nt: MediaNative;
    pid: number;
    /** 自己账号的 uin（highway 帧头要带）。 */
    uin: string | number;
    log?: (message: string) => void;
  };
}

/** 响应里的回执字段（原样解出，不做失败判定）。 */
export interface SendMessageResponseInfo {
  /** 0 = 服务端接受；非 0 见 errMsg。 */
  result: number;
  errMsg: string;
  /** 服务端时间戳（发出去的时刻）。 */
  timestamp1: number;
  /** 群消息的群内序列号（群聊场景）。 */
  groupSequence: number;
  /** 私聊/临时会话的会话级序列号。 */
  privateSequence: number;
  field10: number;
  timestamp2: number;
}

export interface SendMessageReceipt {
  /** 服务端是否真的接受了这条消息（result === 0 且响应体非空）。 */
  ok: boolean;
  scene: SendScene;
  cmd: string;
  result: number;
  errMsg: string;
  /** 群内 seq（群聊）。 */
  groupSequence: number;
  /** 会话级 seq（私聊/临时会话）。 */
  privateSequence: number;
  timestamp: number;
  random: number;
  clientSequence: number;
  /** 本地推导的消息 id：`random & 0x7fffffff || seq`（与 SnowLuma 一致）。 */
  messageId: number;
  /** 实际发出去的请求字节（排查用）。 */
  requestBytes: Uint8Array;
  /** 服务端原始响应字节（排查用）。 */
  responseBytes: Uint8Array;
  response: SendMessageResponseInfo;
  /**
   * 每个媒体元素的上传结果（非媒体消息为空数组）。
   *
   * 拿它来判断「这条消息有没有真的传字节」—— `fastUpload: true` 表示服务端已按
   * md5 持有该资源，走的是秒传（一个字节没传）。
   */
  uploads: SendMediaUploadReport[];
}

/** 一次请求的完整拼装结果（纯函数产物，方便离线校验/落盘）。 */
export interface SendRequestBuild {
  scene: SendScene;
  random: number;
  clientSequence: number;
  /** 已打包成 Elem proto 对象的元素数组。 */
  elems: Record<string, unknown>[];
  /** 交给 protobuf.encode 的请求对象。 */
  request: Record<string, unknown>;
  /** 编码后的请求字节。 */
  bytes: Uint8Array;
}

/** 默认 random：`[1, 0x7fffffff]`，避免 0（0 会被服务端当成「未指定」）。 */
function defaultRandom(): number {
  return randomInt(1, 0x7fffffff);
}

/**
 * 私聊 clientSequence 的自增游标（群聊不用）。与 QQ 客户端一样是会话内单调递增
 * 的序号，用于回执对账；跨进程重启从 1 重新开始没有影响。
 */
let clientSequenceCursor = 0;
export function nextClientSequence(): number {
  clientSequenceCursor = (clientSequenceCursor + 1) & 0xffffffff;
  return clientSequenceCursor;
}

interface RoutingPlan {
  scene: SendScene;
  routingHead: Record<string, unknown>;
  contentHead: Record<string, unknown>;
  /** 需要 ctrl 的场景（私聊/临时会话）才带。 */
  needsControl: boolean;
}

/** 校验目标三选一并给出 routingHead / contentHead。 */
function resolveRouting(params: SendMessageParams): RoutingPlan {
  const targets = [params.groupId, params.userUin, params.groupTemp].filter((t) => t !== undefined);
  if (targets.length !== 1) {
    throw new Error('发消息必须且只能指定一个目标：groupId / userUin / groupTemp');
  }

  if (params.groupId !== undefined) {
    if (!Number.isSafeInteger(params.groupId) || params.groupId <= 0) {
      throw new Error(`groupId 非法: ${String(params.groupId)}`);
    }
    return {
      scene: 'group',
      routingHead: { grp: { groupCode: params.groupId } },
      // 群聊不带 c2cCmd/subType，也不带 ctrl。
      contentHead: { type: 1 },
      needsControl: false,
    };
  }

  if (params.userUin !== undefined) {
    if (!Number.isSafeInteger(params.userUin) || params.userUin <= 0) {
      throw new Error(`userUin 非法: ${String(params.userUin)}`);
    }
    return {
      scene: 'c2c',
      routingHead: {
        c2c: {
          uin: params.userUin,
          ...(params.userUid ? { uid: params.userUid } : {}),
        },
      },
      contentHead: { type: 1, subType: 0, c2cCmd: 11 },
      needsControl: true,
    };
  }

  const temp = params.groupTemp!;
  if (!Number.isSafeInteger(temp.groupUin) || temp.groupUin <= 0) {
    throw new Error(`groupTemp.groupUin 非法: ${String(temp.groupUin)}`);
  }
  if (!temp.toUid.trim()) throw new Error('groupTemp.toUid 不能为空');
  return {
    scene: 'group-temp',
    routingHead: { grpTmp: { groupUin: temp.groupUin, toUid: temp.toUid } },
    contentHead: { type: 1, subType: 0, c2cCmd: 11 },
    needsControl: true,
  };
}

/** 场景推导（`scene` 覆盖优先），供元素校验用。 */
function resolveScene(params: SendMessageParams): SendScene {
  if (params.scene) return params.scene;
  if (params.groupId !== undefined) return 'group';
  if (params.userUin !== undefined) return 'c2c';
  return 'group-temp';
}

/** 媒体上传上下文：把 routing 推导出的场景/目标补进调用方给的三样。 */
function resolveMediaContext(
  params: SendMessageParams,
  onUpload?: (report: SendMediaUploadReport) => void,
): MediaSendContext {
  const media = params.media;
  if (!media) {
    throw new Error('消息里含 image/record/video 元素，需要 params.media（nt/pid/uin）才能上传');
  }
  return {
    nt: media.nt,
    pid: media.pid,
    uin: media.uin,
    scene: resolveScene(params),
    // 群临时会话不算群场景：上传走私聊形状（与 SnowLuma 一致）。
    groupId: params.groupId,
    userUid: params.userUid ?? params.groupTemp?.toUid,
    ...(media.log ? { log: media.log } : {}),
    ...(onUpload ? { onUpload } : {}),
  };
}

/** 路由 / random / sequence / 编码（元素已打包好时用）。 */
function assembleRequest(
  params: SendMessageParams,
  plan: RoutingPlan,
  elems: Record<string, unknown>[],
): SendRequestBuild {
  const random = params.random !== undefined ? params.random : defaultRandom();
  if (!Number.isSafeInteger(random) || random < 0) {
    throw new Error(`random 非法: ${String(params.random)}`);
  }
  const clientSequence =
    params.clientSequence !== undefined
      ? params.clientSequence
      : plan.needsControl
        ? nextClientSequence()
        : 0;
  if (!Number.isSafeInteger(clientSequence) || clientSequence < 0) {
    throw new Error(`clientSequence 非法: ${String(params.clientSequence)}`);
  }

  const request: Record<string, unknown> = {
    routingHead: plan.routingHead,
    contentHead: plan.contentHead,
    messageBody: { richText: { elems } },
    clientSequence,
    random,
  };
  if (plan.needsControl) {
    request.ctrl = { msgFlag: params.msgFlag ?? Math.floor(Date.now() / 1000) };
  }

  return {
    scene: plan.scene,
    random,
    clientSequence,
    elems,
    request,
    bytes: encode(SEND_MESSAGE_REQUEST, request),
  };
}

/**
 * 拼装一条 PbSendMsg 请求（纯函数，不发包）。
 *
 * 元素校验（含场景限制，比如窗口抖动只能私聊）在打包阶段先跑完，再编码。
 * **媒体元素走不了这里**（要先上传），用 {@link buildSendRequestWithMedia} 或
 * {@link sendMessage}。
 */
export function buildSendRequest(params: SendMessageParams): SendRequestBuild {
  const scene = resolveScene(params);
  const plan = resolveRouting(params);
  return assembleRequest(params, plan, buildSendElems(params.elements, { scene }));
}

/** 只要请求字节时的便捷入口。 */
export function buildSendRequestBytes(params: SendMessageParams): Uint8Array {
  return buildSendRequest(params).bytes;
}

/**
 * 拼装一条**含媒体上传**的请求：先把每个媒体元素传进 NTV2 拿 msgInfo，再编码。
 *
 * 整条消息的校验都发生在第一次联网之前（见 `buildSendElemsWithMedia`）。
 */
export async function buildSendRequestWithMedia(
  params: SendMessageParams,
  onUpload?: (report: SendMediaUploadReport) => void,
): Promise<SendRequestBuild> {
  const scene = resolveScene(params);
  const plan = resolveRouting(params);
  if (!params.elements.some((element) => isSendMediaElement(element))) {
    return assembleRequest(params, plan, buildSendElems(params.elements, { scene }));
  }
  const elems = await buildSendElemsWithMedia(
    params.elements,
    resolveMediaContext(params, onUpload),
  );
  return assembleRequest(params, plan, elems);
}

/** 解码结果对象 → 回执字段（缺字段按 0 处理）。 */
function toResponseInfo(body: Record<string, unknown>): SendMessageResponseInfo {
  return {
    result: toInt(body.result),
    errMsg: typeof body.errMsg === 'string' ? body.errMsg : '',
    timestamp1: toInt(body.timestamp1),
    groupSequence: toInt(body.groupSequence),
    privateSequence: toInt(body.privateSequence),
    field10: toInt(body.field10),
    timestamp2: toInt(body.timestamp2),
  };
}

/** 解码 PbSendMsg 响应体。 */
export function parseSendResponse(bytes: Uint8Array): SendMessageResponseInfo {
  return toResponseInfo(decode(SEND_MESSAGE_RESPONSE, bytes) as Record<string, unknown>);
}

/** 回执是否表示「服务端已接受」。 */
export function isSendOk(receipt: SendMessageReceipt): boolean {
  return receipt.ok;
}

/**
 * 发一条消息（群聊 / 私聊 / 群临时会话），返回回执 + 原始请求/响应字节。
 *
 * 传输层异常会抛出（native 直接失败）；服务端拒绝（result != 0）或响应体为空
 * 不抛，而是 `ok: false`，让调用方拿到 result / errMsg 原样上报。
 */
export async function sendMessage(
  nt: TrpcNative,
  pid: number,
  params: SendMessageParams,
): Promise<SendMessageReceipt> {
  const uploads: SendMediaUploadReport[] = [];
  const built = await buildSendRequestWithMedia(params, (report) => uploads.push(report));
  const responseBytes = await sendPacket(nt, pid, SEND_MSG_CMD, built.bytes);
  const response = parseSendResponse(responseBytes);
  const seq = built.scene === 'group' ? response.groupSequence : response.privateSequence;
  const ok = responseBytes.length > 0 && response.result === 0;
  const timestamp = response.timestamp1 || Math.floor(Date.now() / 1000);

  return {
    ok,
    scene: built.scene,
    cmd: SEND_MSG_CMD,
    result: response.result,
    errMsg: response.errMsg || (responseBytes.length === 0 ? '服务端未返回响应体' : ''),
    groupSequence: response.groupSequence,
    privateSequence: response.privateSequence,
    timestamp,
    random: built.random,
    clientSequence: built.clientSequence,
    messageId: built.random & 0x7fffffff || seq,
    requestBytes: built.bytes,
    responseBytes,
    response,
    uploads,
  };
}

/** 群聊发消息（`routingHead.grp`）。 */
export function sendGroupMessage(
  nt: TrpcNative,
  pid: number,
  groupId: number,
  elements: SendElement[],
  rest: Omit<SendMessageParams, 'groupId' | 'elements'> = {},
): Promise<SendMessageReceipt> {
  return sendMessage(nt, pid, { ...rest, groupId, elements });
}

/** 私聊发消息（`routingHead.c2c`）。 */
export function sendC2cMessage(
  nt: TrpcNative,
  pid: number,
  userUin: number,
  elements: SendElement[],
  rest: Omit<SendMessageParams, 'userUin' | 'elements'> = {},
): Promise<SendMessageReceipt> {
  return sendMessage(nt, pid, { ...rest, userUin, elements });
}

// ───────────────────────── 私聊文件（走 msgContent，不是元素） ─────────────────────────

/**
 * 私聊文件的发送参数。
 *
 * 与普通私聊消息的区别就两点：
 *   1. 路由必须是 `routingHead.trans0x211 { ccCmd: 4, uid }` —— 常规 c2c 路由送文件
 *      会被服务端拒收（内容结构对不上）；
 *   2. 文件不走 `richText.elems`，而是 `messageBody.msgContent`（一段 `FileExtra`）。
 *
 * `fileExtra` 由调用方（文件管线）用 `encode(FILE_EXTRA, …)` 编码好传进来 —— 本文件
 * 只做路由 / 序号 / 编解码，不认识文件的具体字段。
 */
export interface SendC2cFileParams {
  /** 对方 QQ 号（对称参数，wire 上只用 uid；可省略）。 */
  userUin?: number;
  /** 对方 uid（**必填**：路由与 FileExtra 的 destUid 都要）。 */
  userUid: string;
  /** 已编码好的 `FileExtra` 字节。 */
  fileExtra: Uint8Array;
  random?: number;
  clientSequence?: number;
  /** 覆盖 ctrl.msgFlag（Unix 秒）；缺省当前时间。 */
  msgFlag?: number;
}

/** 拼装一条私聊文件消息（纯函数）。 */
export function buildSendC2cFileRequest(params: SendC2cFileParams): SendRequestBuild {
  const userUid = params.userUid?.trim();
  if (!userUid) throw new Error('私聊文件需要 userUid');
  if (params.fileExtra.length === 0) throw new Error('私聊文件需要非空的 fileExtra');
  const random = params.random !== undefined ? params.random : defaultRandom();
  if (!Number.isSafeInteger(random) || random < 0) {
    throw new Error(`random 非法: ${String(params.random)}`);
  }
  const clientSequence =
    params.clientSequence !== undefined ? params.clientSequence : nextClientSequence();
  if (!Number.isSafeInteger(clientSequence) || clientSequence < 0) {
    throw new Error(`clientSequence 非法: ${String(params.clientSequence)}`);
  }

  const request: Record<string, unknown> = {
    routingHead: { trans0x211: { ccCmd: 4, uid: userUid } },
    contentHead: { type: 1, subType: 0 },
    messageBody: { msgContent: params.fileExtra },
    clientSequence,
    random,
    ctrl: { msgFlag: params.msgFlag ?? Math.floor(Date.now() / 1000) },
  };

  return {
    scene: 'c2c',
    random,
    clientSequence,
    elems: [],
    request,
    bytes: encode(SEND_MESSAGE_REQUEST, request),
  };
}

/**
 * 发一条**私聊文件**消息（`trans0x211` 路由 + `msgContent`）。
 *
 * 与 {@link sendMessage} 同样：传输层异常抛出，服务端拒绝（result != 0）不抛、
 * 回执里 `ok: false`。
 */
export async function sendC2cFileMessage(
  nt: TrpcNative,
  pid: number,
  params: SendC2cFileParams,
): Promise<SendMessageReceipt> {
  const built = buildSendC2cFileRequest(params);
  const responseBytes = await sendPacket(nt, pid, SEND_MSG_CMD, built.bytes);
  const response = parseSendResponse(responseBytes);
  const seq = response.privateSequence;
  const ok = responseBytes.length > 0 && response.result === 0;

  return {
    ok,
    scene: 'c2c',
    cmd: SEND_MSG_CMD,
    result: response.result,
    errMsg: response.errMsg || (responseBytes.length === 0 ? '服务端未返回响应体' : ''),
    groupSequence: response.groupSequence,
    privateSequence: response.privateSequence,
    timestamp: response.timestamp1 || Math.floor(Date.now() / 1000),
    random: built.random,
    clientSequence: built.clientSequence,
    messageId: built.random & 0x7fffffff || seq,
    requestBytes: built.bytes,
    responseBytes,
    response,
    uploads: [],
  };
}

/** 群临时会话发消息（`routingHead.grpTmp`）。 */
export function sendGroupTempMessage(
  nt: TrpcNative,
  pid: number,
  target: SendGroupTempTarget,
  elements: SendElement[],
  rest: Omit<SendMessageParams, 'groupTemp' | 'elements'> = {},
): Promise<SendMessageReceipt> {
  return sendMessage(nt, pid, { ...rest, groupTemp: target, elements });
}

/**
 * 与其它 spec 一致的自描述命名空间（serialize/deserialize 可直接被
 * `invokeTrpc` 驱动）。需要原始响应字节 / 完整回执时用 {@link sendMessage}。
 */
export namespace SendMsg {
  export const cmd = SEND_MSG_CMD;
  export const reqSchema = SEND_MESSAGE_REQUEST;
  export const respSchema = SEND_MESSAGE_RESPONSE;

  export const serialize = (p: SendMessageParams): Record<string, unknown> =>
    buildSendRequest(p).request;

  export const deserialize = (body: Record<string, unknown>): SendMessageResponseInfo =>
    toResponseInfo(body);

  export const invoke = (
    nt: TrpcNative,
    pid: number,
    params: SendMessageParams,
  ): Promise<SendMessageResponseInfo> =>
    invokeTrpc(nt, pid, SendMsg as TrpcSpec<SendMessageParams, SendMessageResponseInfo>, params);
}

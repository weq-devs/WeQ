/**
 * 发送合并转发（长消息）—— `trpc.group.long_msg_interface.MsgService.SsoSendLongMsg`。
 *
 * 这是 `./get-forward` 的写侧，能力从 SnowLuma
 * `packages/core/src/bridge/apis/forward.ts`（`uploadRecursive` /
 * `buildForwardPushBody`）搬到本包，字段布局与 NapCatQQ 的 `UploadForwardMsg`、
 * Lagrange.Core 的 `LongMsgSendService` 交叉核对过：
 *
 *   1. 把转发里的每条消息编码成 `PushMsgBody`，包进
 *      `LongMsgResult{ action[{ actionCommand: 'MultiMsg', actionData: { msgBody } }] }`；
 *   2. gzip 后作为 `SendLongMsgReq.info.payload` 交给长消息服务，拿回 `resId`；
 *   3. 再用 `resId` 发一张 `com.tencent.multimsg` 卡片（`send-elements` 的
 *      `{ kind: 'forward' }`），收端点开卡片才会按 resId 拉回内容。
 *
 * 请求形状（与 Recv 侧对称，但字段号不同）：
 *   - `SendLongMsgReq{ info{ type, uid{uid}, groupUin, payload }, settings{4,1,7,0} }`
 *   - 群聊 type=3 且 `uid.uid` / `groupUin` 都写群号；私聊 type=1 且 `uid.uid` 写自己 uid；
 *   - 响应 `SendLongMsgResp.result.resId` 就是卡片的 `resid`。
 *
 * 相比「只发一张卡片」，这里多做了两件本包原先没有的事：
 *
 *   1. **嵌套转发 piggyback**：节点给了 `innerForward` 时递归上传内层，把节点内容
 *      替换成指向内层 resId 的卡片，并把内层 msgBody 以 `actionCommand = uuid` 挂在
 *      外层 `LongMsgResult` 里。收端只拉最外层一次，就能顺着卡片 JSON 的
 *      `uniseq → actionCommand` 走完整棵树（对齐 NapCat 的 `uploadForwardedNodesPacket`）。
 *   2. **节点内媒体上传**：节点元素里的图片 / 语音 / 视频先走 NTV2
 *      （`highway/media-upload`），产物直接作为该节点的 `commonElem(serviceType=48)`。
 *      私聊转发含媒体时必须给 `userUid`，否则上传拿不到场景。
 *
 * 节点级装扮（气泡 / 字体 / 挂件）是可选能力：`ForwardNode.dress` 给了就按
 * `send-elements` 的 `SendDress` 规则前置装扮 elems。注意字体有**两个** wire 槽位：
 * `fontId` → `fontId1`(tag 56) 原样、`fontId2` → `fontId2`(tag 15) 字节交换形态，
 * 都能单独给。
 */

import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { decode, encode, message, type ProtoMessage } from '../protobuf';
import { sendPacket, type OidbNative, type TrpcNative } from '../transport';
import { invokeTrpc, type TrpcSpec } from '../oidb/invoke';
import { LONG_MSG_RESULT, LONG_MSG_SETTINGS, LONG_MSG_UID } from './get-forward';
import {
  buildSendElems,
  buildSendElemsWithMedia,
  isSendMediaElement,
  type SendDress,
  type SendElement,
  type SendScene,
} from './send-elements';

export const SSO_SEND_LONG_MSG_CMD = 'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg';

/** 发送长消息要用的 native 能力：OIDB（节点内媒体上传）+ 原始 SSO 包（长消息本身）。 */
export type ForwardNative = OidbNative & TrpcNative;

// ---------- 请求 / 响应 schema ----------

/** `SendLongMsgReq.info`：type 1=私聊 / 3=群聊；uid 群聊放群号、私聊放自己 uid。 */
export const SEND_LONG_MSG_INFO: ProtoMessage = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'uid', tag: 2, type: LONG_MSG_UID },
  { name: 'groupUin', tag: 3, type: 'uint32' },
  { name: 'payload', tag: 4, type: 'bytes' },
]);

export const SEND_LONG_MSG_REQ: ProtoMessage = message([
  { name: 'info', tag: 2, type: SEND_LONG_MSG_INFO },
  { name: 'settings', tag: 15, type: LONG_MSG_SETTINGS },
]);

export const SEND_LONG_MSG_RESP_RESULT: ProtoMessage = message([
  { name: 'resId', tag: 3, type: 'string' },
]);

export const SEND_LONG_MSG_RESP: ProtoMessage = message([
  { name: 'result', tag: 2, type: SEND_LONG_MSG_RESP_RESULT },
  { name: 'settings', tag: 15, type: LONG_MSG_SETTINGS },
]);

/** 发送侧默认 settings：`{4,1,7,0}`（与 Recv 侧的 `{2,0,0,0}` 不同，照抄上游）。 */
export const DEFAULT_SEND_SETTINGS = { field1: 4, field2: 1, field3: 7, field4: 0 } as const;

/** 调用方可覆盖 settings 的 4 个 uint32。 */
export interface LongMsgSettingsInput {
  field1?: number;
  field2?: number;
  field3?: number;
  field4?: number;
}

// ---------- 入参 ----------

/**
 * 合并转发里的一条消息（一个「节点」）。
 *
 * `elements` 就是发送元素（text / image / face / … 与收侧同构），所以
 * 「收到的消息元素直接塞进来再转发」是可行的。
 */
export interface ForwardNode {
  /** 该条消息的发送者 QQ 号；缺省用自己 uin。 */
  userUin?: number;
  /** 收端显示的发送者昵称；缺省用 QQ 号。群聊节点写进 `grp.memberName`。 */
  nickname?: string;
  /** 该条消息的内容（至少一个元素；节点只有 innerForward 时允许为空数组）。 */
  elements: SendElement[];
  /** 该条消息的显示时间（Unix 秒）；缺省当前时间。 */
  time?: number;
  /** 回显用消息 id；缺省随机。 */
  msgId?: number;
  /** 回显用序列号；缺省随机。 */
  msgSeq?: number;
  /**
   * 该条消息自己的装扮（气泡 / 字体 / 挂件），可选。
   *
   * 字体两个 wire 槽位都能给：`fontId` 写 `fontId1`(tag 56) 原样、`fontId2` 写
   * `fontId2`(tag 15) 的**字节交换**形态 —— 两处都收真实 itemId，换算在
   * `send-elements` 里做。详见 {@link SendDress}。
   */
  dress?: SendDress;
  /**
   * 这个节点本身就是一段嵌套转发：给了就递归上传内层，节点内容被替换成指向
   * 内层 resId 的卡片，内层 msgBody 以 uuid 形式 piggyback 到外层。
   */
  innerForward?: ForwardNode[];
}

/** 发送目标：群聊 / 私聊二选一。 */
export interface SendForwardParams {
  /** 群聊群号（与 userUin 二选一）。 */
  groupId?: number;
  /** 私聊目标 QQ 号（与 groupId 二选一）。 */
  userUin?: number;
  /** 私聊目标 uid：仅当节点含图片 / 语音 / 视频（要走 NTV2）时才必需。 */
  userUid?: string;
  /** 自己账号的 QQ 号（highway 帧头 + 节点缺省 fromUin）。 */
  selfUin: string | number;
  /** 自己账号的 uid（发送请求的 uid 槽位 + 私聊节点 toUid）。 */
  selfUid: string;
  /** 转发内容（至少一个节点）。 */
  nodes: ForwardNode[];
  /** 覆盖发送请求的 settings（缺省 `{4,1,7,0}`）。 */
  settings?: LongMsgSettingsInput;
  /** 诊断日志（媒体上传阶段用）。 */
  log?: (message: string) => void;
}

/** 嵌套层最大深度（含最外层），防止调用方构造出无限递归。 */
export const FORWARD_MAX_DEPTH = 8;

/** 每一层（顶层 + 每个嵌套层）的上传明细，方便排查 / 单测。 */
export interface ForwardLevel {
  resId: string;
  /**
   * 这一层的 piggyback 标识：内层用它当 `actionCommand`，外层卡片 JSON 的
   * `uniseq` 与它相等。最外层这一项没有外部消费者（没有更外层了）。
   */
  uuid: string;
  /** 这一层的消息列表（已编码好的 PushMsgBody）。 */
  msgBody: Record<string, unknown>[];
  requestBytes: Uint8Array;
  responseBytes: Uint8Array;
}

/** 一次发送的完整结果（含原始字节）。 */
export interface SendForwardResult {
  /** 服务端签发的长消息 id —— 结果卡片要用的 `resid`。 */
  resId: string;
  cmd: string;
  scene: SendScene;
  /** 最外层那一层的请求 / 响应字节（= 结果卡片对应的长消息）。 */
  requestBytes: Uint8Array;
  responseBytes: Uint8Array;
  /** 解码后的响应（`{ result: { resId } }`）。 */
  response: Record<string, unknown>;
  /** 每层明细：[0] 是最外层，其后是各嵌套层（上传完成顺序）。 */
  levels: ForwardLevel[];
}

// ---------- 预览文本（嵌套层卡片用） ----------

function previewFromElements(elements: readonly SendElement[]): string {
  for (const element of elements) {
    switch (element.kind) {
      case 'text':
        if (element.textContent) return element.textContent.slice(0, 30);
        break;
      case 'image':
        return '[图片]';
      case 'record':
        return '[语音]';
      case 'video':
        return '[视频]';
      case 'forward':
        return '[聊天记录]';
      case 'face':
      case 'mface':
        return '[表情]';
      default:
        break;
    }
  }
  return '';
}

function deriveInnerSource(nodes: readonly ForwardNode[], isGroup: boolean): string {
  const nicks: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const name = (node.nickname ?? '').trim() || String(node.userUin ?? '');
    if (name && !seen.has(name)) {
      seen.add(name);
      nicks.push(name);
    }
    if (nicks.length >= 4) break;
  }
  if (nicks.length === 0) return isGroup ? '群聊的聊天记录' : '聊天记录';
  return `${nicks.join('和')}的聊天记录`;
}

function previewLinesFromNodes(nodes: readonly ForwardNode[]): { text: string }[] {
  return nodes.slice(0, 4).map((node) => {
    const name = (node.nickname ?? '').trim() || String(node.userUin ?? 'QQ用户');
    const preview = previewFromElements(node.elements);
    return { text: preview ? `${name}: ${preview}` : name };
  });
}

// ---------- 单个节点 → PushMsgBody ----------

/** 单节点编码上下文（由 {@link sendForward} 组装）。 */
export interface ForwardEncodeContext {
  nt: ForwardNative;
  pid: number;
  selfUin: number;
  selfUid: string;
  scene: SendScene;
  groupId?: number;
  userUid?: string;
  log?: (message: string) => void;
}

function randomUint32(): number {
  return Math.floor(Math.random() * 0x7fffffff) >>> 0 || 1;
}

/** 节点元素 → Elem proto 数组（含节点内媒体上传与可选装扮）。 */
async function buildNodeElems(
  node: ForwardNode,
  ctx: ForwardEncodeContext,
): Promise<Record<string, unknown>[]> {
  const dress = node.dress;
  if (!Array.isArray(node.elements) || node.elements.length === 0) {
    throw new Error('合并转发节点至少要有一个元素');
  }
  if (!node.elements.some(isSendMediaElement)) {
    return buildSendElems(node.elements, { scene: ctx.scene, ...(dress ? { dress } : {}) });
  }
  // 节点内含媒体：先按目标场景上传 NTV2，再拼 commonElem(48)。
  const userUid = ctx.userUid?.trim() ?? '';
  if (ctx.scene !== 'group' && !userUid) {
    throw new Error('私聊合并转发的节点里含图片/语音/视频时，需要 userUid（NTV2 上传要场景）');
  }
  return buildSendElemsWithMedia(node.elements, {
    nt: ctx.nt,
    pid: ctx.pid,
    uin: ctx.selfUin,
    scene: ctx.scene,
    ...(dress ? { dress } : {}),
    ...(ctx.groupId !== undefined ? { groupId: ctx.groupId } : {}),
    ...(userUid ? { userUid } : {}),
    ...(ctx.log ? { log: ctx.log } : {}),
  });
}

/**
 * 一个节点 → `PushMsgBody`。
 *
 * 头部形态对齐 NapCat `PacketMsgBuilder.buildFakeMsg` / SnowLuma
 * `buildForwardPushBody`：群聊节点带 `grp{groupUin,memberName}`，私聊节点带
 * `forward{friendName}` + `toUid`。这样收端按常规 msg-push 解码就能拿到
 * 「谁、在哪个群、什么时候说的」。
 */
export async function buildForwardNodeBody(
  node: ForwardNode,
  ctx: ForwardEncodeContext,
): Promise<Record<string, unknown>> {
  const fromUin = node.userUin && node.userUin > 0 ? node.userUin : ctx.selfUin;
  if (!Number.isSafeInteger(fromUin) || fromUin <= 0) {
    throw new Error(`合并转发节点 userUin 非法：${String(node.userUin ?? ctx.selfUin)}`);
  }
  const nickname = (node.nickname ?? '').trim() || String(fromUin);
  const elems = await buildNodeElems(node, ctx);
  const now = Math.floor(Date.now() / 1000);
  const isGroup = ctx.scene === 'group';

  return {
    responseHead: {
      fromUin,
      fromUid: '',
      ...(isGroup
        ? { grp: { groupUin: ctx.groupId ?? 0, memberName: nickname } }
        : { forward: { friendName: nickname }, toUid: ctx.selfUid }),
    },
    contentHead: {
      // 群聊节点 82、私聊节点 9/subType 4（NapCat / SnowLuma 同款）。
      msgType: isGroup ? 82 : 9,
      ...(isGroup ? {} : { subType: 4 }),
      msgId: node.msgId && node.msgId > 0 ? node.msgId : randomUint32(),
      sequence: node.msgSeq && node.msgSeq > 0 ? node.msgSeq : randomUint32(),
      timestamp: node.time && node.time > 0 ? Math.floor(node.time) : now,
    },
    body: { richText: { elems } },
  };
}

// ---------- 递归上传 ----------

interface InnerAction {
  uuid: string;
  msgBody: Record<string, unknown>[];
}

interface UploadedLevel {
  resId: string;
  uuid: string;
  msgBody: Record<string, unknown>[];
  innerActions: InnerAction[];
  requestBytes: Uint8Array;
  responseBytes: Uint8Array;
}

async function uploadLevel(
  ctx: ForwardEncodeContext,
  nodes: readonly ForwardNode[],
  settings: LongMsgSettingsInput | undefined,
  levels: ForwardLevel[],
  depth = 0,
): Promise<UploadedLevel> {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('合并转发至少要有一个节点（nodes 不能为空）');
  }
  if (depth >= FORWARD_MAX_DEPTH) {
    throw new Error(`合并转发嵌套层数超过上限 ${FORWARD_MAX_DEPTH}`);
  }
  const isGroup = ctx.scene === 'group';
  const innerActions: InnerAction[] = [];
  const prepared: ForwardNode[] = [];

  // 先把嵌套层递归传完 —— 内层 resId / uuid 出来之后，外层卡片才写得出来。
  for (const node of nodes) {
    if (node.innerForward && node.innerForward.length > 0) {
      const inner = await uploadLevel(ctx, node.innerForward, settings, levels, depth + 1);
      // 关键：外层卡片 JSON 的 uniseq 必须与 piggyback 的 actionCommand 一致，
      // 收端才能一次拉取走完整棵树（SnowLuma / NapCat 同款对齐）。
      innerActions.push({ uuid: inner.uuid, msgBody: inner.msgBody });
      innerActions.push(...inner.innerActions);
      prepared.push({
        ...node,
        innerForward: undefined,
        elements: [
          {
            kind: 'forward',
            resId: inner.resId,
            forwardUuid: inner.uuid,
            forwardSource: deriveInnerSource(node.innerForward, isGroup),
            forwardSummary: `查看${node.innerForward.length}条转发消息`,
            forwardPrompt: '[聊天记录]',
            forwardNews: previewLinesFromNodes(node.innerForward),
            forwardTSum: node.innerForward.length,
          },
        ],
      });
      continue;
    }
    prepared.push(node);
  }

  const msgBody = await Promise.all(prepared.map((node) => buildForwardNodeBody(node, ctx)));

  const longMsgResult = encode(LONG_MSG_RESULT, {
    action: [
      { actionCommand: 'MultiMsg', actionData: { msgBody } },
      ...innerActions.map((action) => ({
        actionCommand: action.uuid,
        actionData: { msgBody: action.msgBody },
      })),
    ],
  });
  const payload = new Uint8Array(gzipSync(Buffer.from(longMsgResult)));

  const request = {
    info: {
      type: isGroup ? 3 : 1,
      uid: { uid: isGroup ? String(ctx.groupId) : ctx.selfUid },
      ...(isGroup ? { groupUin: ctx.groupId } : {}),
      payload,
    },
    settings: settings ?? DEFAULT_SEND_SETTINGS,
  };
  const requestBytes = encode(SEND_LONG_MSG_REQ, request);
  const responseBytes = await sendPacket(ctx.nt, ctx.pid, SSO_SEND_LONG_MSG_CMD, requestBytes);
  if (responseBytes.length === 0) {
    throw new Error('发送合并转发失败：服务端未返回响应体');
  }
  const decoded = decode(SEND_LONG_MSG_RESP, responseBytes) as { result?: { resId?: string } };
  const resId = typeof decoded.result?.resId === 'string' ? decoded.result.resId : '';
  if (!resId) throw new Error('发送合并转发失败：响应里没有 resId');

  const level: UploadedLevel = {
    resId,
    uuid: randomUUID(),
    msgBody,
    innerActions,
    requestBytes,
    responseBytes,
  };
  // 记录顺序是「内层先、本层后」，sendForward 收尾时再翻成最外层在前。
  levels.push({ resId, uuid: level.uuid, msgBody, requestBytes, responseBytes });
  return level;
}

// ---------- 公共入口 ----------

export namespace SendLongMsg {
  export const cmd = SSO_SEND_LONG_MSG_CMD;
  export const reqSchema = SEND_LONG_MSG_REQ;
  export const respSchema = SEND_LONG_MSG_RESP;

  /** 序列化请求体（payload 由调用方自己 gzip；完整管线见 {@link sendForward}）。 */
  export const serialize = (p: {
    groupId?: number;
    selfUid: string;
    payload: Uint8Array;
    settings?: LongMsgSettingsInput;
  }): Record<string, unknown> => {
    const isGroup = p.groupId !== undefined;
    return {
      info: {
        type: isGroup ? 3 : 1,
        uid: { uid: isGroup ? String(p.groupId) : p.selfUid },
        ...(isGroup ? { groupUin: p.groupId } : {}),
        payload: p.payload,
      },
      settings: p.settings ?? DEFAULT_SEND_SETTINGS,
    };
  };

  export const deserialize = (body: Record<string, unknown>): { resId: string } => {
    const result = body.result as { resId?: string } | undefined;
    return { resId: typeof result?.resId === 'string' ? result.resId : '' };
  };

  export const invoke = (
    nt: TrpcNative,
    pid: number,
    params: {
      groupId?: number;
      selfUid: string;
      payload: Uint8Array;
      settings?: LongMsgSettingsInput;
    },
  ): Promise<{ resId: string }> =>
    invokeTrpc(nt, pid, SendLongMsg as TrpcSpec<typeof params, { resId: string }>, params);
}

/**
 * 发送合并转发内容（SsoSendLongMsg），只返回服务端签发的 `resId`。
 *
 * 拿到 resId 后用 `sendMessage` / `sendElements` 发一张
 * `{ kind: 'forward', resId }` 卡片即可 —— 本函数只负责上传内容，不发卡片。
 */
export async function uploadForward(
  nt: ForwardNative,
  pid: number,
  params: SendForwardParams,
): Promise<string> {
  return (await sendForward(nt, pid, params)).resId;
}

/**
 * 发送合并转发内容，返回 resId + 每层的原始请求 / 响应字节。
 *
 * 群聊 / 私聊二选一（`groupId` / `userUin`）；私聊节点含媒体时必须给 `userUid`。
 * 节点级装扮走 `ForwardNode.dress`。
 */
export async function sendForward(
  nt: ForwardNative,
  pid: number,
  params: SendForwardParams,
): Promise<SendForwardResult> {
  const hasGroup = params.groupId !== undefined;
  const hasUser = params.userUin !== undefined;
  if (hasGroup === hasUser) {
    throw new Error('合并转发必须且只能指定一个目标：groupId 或 userUin');
  }
  if (hasGroup) {
    if (!Number.isSafeInteger(params.groupId) || (params.groupId as number) <= 0) {
      throw new Error(`groupId 非法: ${String(params.groupId)}`);
    }
  } else if (!Number.isSafeInteger(params.userUin) || (params.userUin as number) <= 0) {
    throw new Error(`userUin 非法: ${String(params.userUin)}`);
  }
  if (!params.selfUid.trim()) throw new Error('合并转发需要 selfUid');
  const selfUin = Number(params.selfUin);
  if (!Number.isSafeInteger(selfUin) || selfUin <= 0) {
    throw new Error(`selfUin 非法: ${String(params.selfUin)}`);
  }

  const ctx: ForwardEncodeContext = {
    nt,
    pid,
    selfUin,
    selfUid: params.selfUid,
    scene: hasGroup ? 'group' : 'c2c',
    ...(params.groupId !== undefined ? { groupId: params.groupId } : {}),
    ...(params.userUid ? { userUid: params.userUid } : {}),
    ...(params.log ? { log: params.log } : {}),
  };

  const levels: ForwardLevel[] = [];
  const top = await uploadLevel(ctx, params.nodes, params.settings, levels);
  // uploadLevel 记录的是「内层先、最外层最后」，这里翻成最外层在前（结果卡片那层是 [0]）。
  levels.reverse();

  return {
    resId: top.resId,
    cmd: SSO_SEND_LONG_MSG_CMD,
    scene: ctx.scene,
    requestBytes: top.requestBytes,
    responseBytes: top.responseBytes,
    response: { result: { resId: top.resId } },
    levels,
  };
}

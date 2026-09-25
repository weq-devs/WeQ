// 推荐联系人 / 推荐群 Ark 卡片 —— 「取卡 → 发送」两步合一。
//
// 搬运自 SnowLuma `packages/protocol/src/oidb-services/contacts/` 的两个取卡服务
// 与 `packages/proto-defs/src/oidb-actions/contact-ark.ts` 的字段布局。与 SnowLuma
// 的区别只有一处：那边只**取** ark JSON（`getBuddyRecommendArk` /
// `getGroupRecommendArk`），这里把「取」和「发」接在一起，直接落到会话里。
//
//   第 1 步（取卡：服务端生成 ark JSON 字符串）
//     好友：OidbSvcTrpcTcp.0x12b6_0 getBuddyRecommendContactArkJson
//           请求 {1:uin, 2:phone, 3:jump_url}；响应 {1:ark}。
//     群聊：OidbSvcTrpcTcp.0x8b7_5 getGroupRecommendContactArkJson（uin-form 信封）
//           请求 {1:reqType=1, 2:groupCode, 5:flag=1}；响应 {1:errCode, 5:arkJson}。
//   第 2 步（发送）
//     把拿到的 ark JSON 原样当 lightApp 元素（`{ kind: 'ark', arkData }`）交给
//     `MessageSvc.PbSendMsg`，与 QQ 客户端发出的推荐卡片同形。
//
// 两个 id 容易搞混，这里刻意分开命名：
//   - `targetId`  = 卡片发到哪（群号 / 对方 QQ 号）；
//   - `contactId` = 卡片推荐谁（被推荐的好友 QQ 号 / 群号）。

import { sendMessage, type SendMessageReceipt } from '../msg/send';
import { message } from '../protobuf';
import type { OidbNative, TrpcNative } from '../transport';
import { invokeOidb, type OidbSpec } from './invoke';

/** 取卡 + 发送两步都要用到的 native 能力（OIDB 信封 + 原始 SSO 包）。 */
export type ContactArkNative = OidbNative & TrpcNative;

// ───────────────────────────── 第 1 步：取卡 ─────────────────────────────

/** 0x12b6_0 的 inner body：uin / phoneNumber / jumpUrl。 */
const BUDDY_ARK_REQ = message([
  { name: 'uin', tag: 1, type: 'uint32' },
  { name: 'phoneNumber', tag: 2, type: 'string' },
  { name: 'jumpUrl', tag: 3, type: 'string' },
]);

/** 响应 {1:ark}。 */
const BUDDY_ARK_RESP = message([{ name: 'ark', tag: 1, type: 'string' }]);

export interface BuddyRecommendArkParams {
  /** 被推荐的好友 QQ 号。 */
  uin: number;
  /** 手机号；缺省（或空串）写 `'-'`，与 NT 客户端硬编码的占位一致。 */
  phoneNumber?: string;
}

/** 取「推荐好友」卡片 JSON（0x12b6_0）。 */
export namespace GetBuddyRecommendArk {
  export const command = 0x12b6;
  export const subCommand = 0;
  /** 普通 OIDB 信封（不是 uin-form）—— 0x9130_0 的旧结论已在 SnowLuma #149 修正。 */
  export const uinForm = false;
  export const reqSchema = BUDDY_ARK_REQ;
  export const respSchema = BUDDY_ARK_RESP;

  export type Params = BuddyRecommendArkParams;

  /**
   * jump_url 是客户端内核硬编码的模板，服务端只把它原样回填进卡片；换成别的形状
   * 会拿到一张跳转不对的卡，所以这里照抄 NT 模板。
   */
  export const serialize = (p: Params): Record<string, unknown> => {
    assertPositiveInt(p.uin, 'uin');
    return {
      uin: p.uin,
      phoneNumber: p.phoneNumber?.trim() ? p.phoneNumber : '-',
      jumpUrl: `mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=${p.uin}`,
    };
  };

  /** 响应字段 1 就是卡片 JSON；字段缺失（异常回包）时返回空串，由调用方判定。 */
  export const deserialize = (body: Record<string, unknown>): string =>
    typeof body.ark === 'string' ? body.ark : '';

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<string> =>
    invokeOidb(nt, pid, GetBuddyRecommendArk as OidbSpec<Params, string>, params);
}

/** 0x8b7_5 的 inner body：reqType / groupCode / flag。 */
const GROUP_ARK_REQ = message([
  { name: 'reqType', tag: 1, type: 'uint32' },
  { name: 'groupCode', tag: 2, type: 'uint32' },
  { name: 'flag', tag: 5, type: 'uint32' },
]);

/** 响应 {1:errCode, 5:arkJson}。 */
const GROUP_ARK_RESP = message([
  { name: 'errCode', tag: 1, type: 'uint32' },
  { name: 'arkJson', tag: 5, type: 'string' },
]);

export interface GroupRecommendArkParams {
  /** 被推荐的群号。 */
  groupId: number;
}

/** 取「推荐群」卡片 JSON（0x8b7_5）。 */
export namespace GetGroupRecommendArk {
  export const command = 0x8b7;
  export const subCommand = 5;
  /** uin-form OIDB（信封 reserved=1）—— 与好友卡片那条不同，别抄错。 */
  export const uinForm = true;
  export const reqSchema = GROUP_ARK_REQ;
  export const respSchema = GROUP_ARK_RESP;

  export type Params = GroupRecommendArkParams;

  /** reqType / flag 是 NT 编码器写死的常量（都是 1），不要改成别的值。 */
  export const serialize = (p: Params): Record<string, unknown> => {
    assertPositiveInt(p.groupId, 'groupId');
    return { reqType: 1, groupCode: p.groupId, flag: 1 };
  };

  /** 响应字段 5 是卡片 JSON；字段缺失时返回空串，由调用方判定。 */
  export const deserialize = (body: Record<string, unknown>): string =>
    typeof body.arkJson === 'string' ? body.arkJson : '';

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<string> =>
    invokeOidb(nt, pid, GetGroupRecommendArk as OidbSpec<Params, string>, params);
}

// ───────────────────────────── 第 2 步：发送 ─────────────────────────────

/** 卡片推荐什么：`'qq'` = 好友，`'group'` = 群。 */
export type ContactArkKind = 'qq' | 'group';

/** 卡片发到哪：`'c2c'` = 私聊，`'group'` = 群聊。 */
export type ContactArkPeerType = 'c2c' | 'group';

export interface SendContactArkParams {
  /** 发送目标类型。 */
  peerType: ContactArkPeerType;
  /** 发送目标：`'group'` 时为群号，`'c2c'` 时为对方 QQ 号。 */
  targetId: number;
  /** 卡片推荐什么。 */
  kind: ContactArkKind;
  /** 被推荐的好友 QQ 号 / 群号。 */
  contactId: number;
  /** 推荐好友时的手机号；缺省 `'-'`（见 {@link GetBuddyRecommendArk.serialize}）。 */
  phoneNumber?: string;
  /** 私聊发送时的对端 uid（可选：卡片是 lightApp 元素，非媒体不强制 uid）。 */
  userUid?: string;
}

export interface SendContactArkResult {
  kind: ContactArkKind;
  /** 被推荐的好友 QQ 号 / 群号（回显）。 */
  contactId: number;
  /** 服务端生成的卡片 JSON —— 发出去的就是这一份，排查时可对照。 */
  arkJson: string;
  /** 发送回执；`receipt.ok === false` 就是没发出去（原因见 result / errMsg）。 */
  receipt: SendMessageReceipt;
}

/**
 * 只取卡不发送 —— 「推荐好友 / 推荐群」的 ark JSON。
 *
 * 常规用法是 {@link sendContactArk}（取完直接发）；这个函数留给需要自己构造元素、
 * 或者只想排查取卡结果的调用方。
 */
export function getContactArk(
  nt: OidbNative,
  pid: number,
  params: { kind: ContactArkKind; contactId: number; phoneNumber?: string },
): Promise<string> {
  if (params.kind === 'qq') {
    return GetBuddyRecommendArk.invoke(nt, pid, {
      uin: params.contactId,
      ...(params.phoneNumber !== undefined ? { phoneNumber: params.phoneNumber } : {}),
    });
  }
  return GetGroupRecommendArk.invoke(nt, pid, { groupId: params.contactId });
}

/**
 * 发一张「推荐好友 / 推荐群」卡片：**先取卡、再直接发出**（两步）。
 *
 * 服务端生成的 ark JSON 当 lightApp 元素发给目标会话，收端 QQ 会渲染成可点击的
 * 联系人 / 群卡片。
 *
 * 失败不静默：取到空卡会抛错（说明服务端没给出卡片，不发一张空白卡）；发送被服务端
 * 拒绝不抛，原样放进 `receipt`，调用方必须检查 `receipt.ok`。
 */
export async function sendContactArk(
  nt: ContactArkNative,
  pid: number,
  params: SendContactArkParams,
): Promise<SendContactArkResult> {
  assertPositiveInt(params.targetId, 'targetId');
  assertPositiveInt(params.contactId, 'contactId');

  const arkJson = await getContactArk(nt, pid, {
    kind: params.kind,
    contactId: params.contactId,
    ...(params.phoneNumber !== undefined ? { phoneNumber: params.phoneNumber } : {}),
  });
  if (!arkJson.trim()) {
    throw new Error(
      `服务端没有生成推荐卡片（kind=${params.kind} contactId=${params.contactId}）：` +
        'ark JSON 为空，不发空白卡。请确认该好友 / 群存在且当前账号可见。',
    );
  }

  const receipt = await sendMessage(nt, pid, {
    ...(params.peerType === 'group' ? { groupId: params.targetId } : { userUin: params.targetId }),
    ...(params.peerType === 'c2c' && params.userUid ? { userUid: params.userUid } : {}),
    elements: [{ kind: 'ark', arkData: arkJson }],
  });

  return { kind: params.kind, contactId: params.contactId, arkJson, receipt };
}

/** 发「推荐好友」卡片（私聊 / 群聊发送，卡片里推荐一个 QQ 号）。 */
export function sendBuddyContactArk(
  nt: ContactArkNative,
  pid: number,
  params: Omit<SendContactArkParams, 'kind'>,
): Promise<SendContactArkResult> {
  return sendContactArk(nt, pid, { ...params, kind: 'qq' });
}

/** 发「推荐群」卡片（私聊 / 群聊发送，卡片里推荐一个群号）。 */
export function sendGroupContactArk(
  nt: ContactArkNative,
  pid: number,
  params: Omit<SendContactArkParams, 'kind'>,
): Promise<SendContactArkResult> {
  return sendContactArk(nt, pid, { ...params, kind: 'group' });
}

function assertPositiveInt(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${what} 必须是正整数，收到 ${String(value)}`);
  }
}

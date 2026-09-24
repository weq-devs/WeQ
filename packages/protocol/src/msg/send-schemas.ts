/**
 * 发消息（`MessageSvc.PbSendMsg`）的 proto schema —— 只放「发送方向独有」的两类：
 *
 *   1. 发送容器：RoutingHead(c2c/grp/grpTmp/trans0x211) / ContentHead /
 *      MessageBody / Request / Response —— 收侧是 PushMsgBody，两边容器不同。
 *   2. 只在发送时构造的 pbElem：@ 的 MentionExtra、超级表情 QFaceExtra、
 *      小黄脸 QSmallFaceExtra、抖动 PokeExtra、商城表情 pbReserve。
 *
 * **元素本体不在这里**：`Elem` 及其子树（text/face/marketFace/richMsg/lightApp/
 * commonElem/replyElement…）与收侧共用 `./schemas`。`protobuf.ts` 的 encode/decode
 * 是同一份 schema 的两向实现，所以发消息的「元素 → bytes」这一步是直接复用收侧
 * schema，不需要第二套定义；只是收侧当初为渲染做过减法（比如 MARKET_FACE 只留了
 * 5 个字段），缺的字段在 `./schemas` 里补齐（加法，解码路径不受影响）。
 *
 * 字段布局抄自 SnowLuma `packages/proto-defs/src/action.ts`（SendMessageRequest /
 * SendMessageResponse / RoutingHead / MentionExtraSend）与
 * `packages/proto-defs/src/element.ts`（QFaceExtra / QSmallFaceExtra / PokeExtra /
 * MarketFacePbReserve），以及 `packages/core/src/bridge/apis/message.ts` 的
 * sendGroup / sendPrivate 请求拼装。
 *
 * @ 的 MentionExtra 复用收侧的 `TEXT_PB_RESERVE`（tag 布局一致：3=type、4=uin、
 * 5=field5、9=uid），不另开一份；字段名以收侧为准，映射关系见 `./send-elements`。
 */

import { message, type ProtoMessage } from '../protobuf';
import { ELEM } from './schemas';

const f = (
  name: string,
  tag: number,
  type: ProtoMessage['fields'][number]['type'],
  extra: Partial<{ repeated: boolean; force: boolean }> = {},
) => ({ name, tag, type, ...extra });

// ---------- RoutingHead ----------

/** 普通私聊路由（RoutingHead field 1）。媒体消息需要 uid，纯文本可只给 uin。 */
export const ROUTING_C2C: ProtoMessage = message([f('uin', 1, 'uint32'), f('uid', 2, 'string')]);

/** 群聊路由（RoutingHead field 2）。 */
export const ROUTING_GROUP: ProtoMessage = message([f('groupCode', 1, 'uint64')]);

/** 群临时会话路由（RoutingHead field 3）：源群号 + 对端 uid。 */
export const ROUTING_GROUP_TEMP: ProtoMessage = message([
  f('groupUin', 3, 'uint64'),
  f('toUid', 4, 'string'),
]);

/**
 * trans0x211 路由（RoutingHead field 15）—— **只给 c2c 文件/设备会话用**。
 * 常规私聊走了这条会被服务端拒收；本文件的发消息入口不产出它，保留 schema 供
 * 后续文件发送（ccCmd=4）与设备会话（ccCmd=7）复用。
 */
export const ROUTING_TRANS_0X211: ProtoMessage = message([
  f('toUin', 1, 'uint64'),
  f('ccCmd', 2, 'uint32'),
  f('uid', 8, 'string'),
]);

export const ROUTING_HEAD: ProtoMessage = message([
  f('c2c', 1, ROUTING_C2C),
  f('grp', 2, ROUTING_GROUP),
  f('grpTmp', 3, ROUTING_GROUP_TEMP),
  f('trans0x211', 15, ROUTING_TRANS_0X211),
]);

// ---------- ContentHead / MessageBody ----------

/** 发送侧 ContentHead：群聊只给 type=1；私聊/临时会话另给 c2cCmd=11。 */
export const SEND_CONTENT_HEAD: ProtoMessage = message([
  f('type', 1, 'uint32'),
  f('subType', 2, 'uint32'),
  f('c2cCmd', 3, 'uint32'),
]);

/** 控制结构（Request field 12）。私聊/临时会话带 msgFlag=当前秒；群聊不带。 */
export const MESSAGE_CONTROL: ProtoMessage = message([f('msgFlag', 1, 'int32')]);

/** 发送侧 RichText：只装 elems（收侧还有 notOnlineFile / ptt）。 */
export const SEND_RICH_TEXT: ProtoMessage = message([f('elems', 2, ELEM, { repeated: true })]);

export const SEND_MESSAGE_BODY: ProtoMessage = message([
  f('richText', 1, SEND_RICH_TEXT),
  f('msgContent', 2, 'bytes'),
]);

// ---------- Request / Response ----------

export const SEND_MESSAGE_REQUEST: ProtoMessage = message([
  f('routingHead', 1, ROUTING_HEAD),
  f('contentHead', 2, SEND_CONTENT_HEAD),
  f('messageBody', 3, SEND_MESSAGE_BODY),
  f('clientSequence', 4, 'uint32'),
  f('random', 5, 'uint32'),
  f('syncCookie', 6, 'bytes'),
  f('via', 8, 'uint32'),
  f('dataStatist', 9, 'uint32'),
  f('ctrl', 12, MESSAGE_CONTROL),
  f('multiSendSeq', 14, 'uint32'),
]);

/**
 * 发送响应：result(1)=0 才是真的发出去了；routing 不同回执字段不同 ——
 * 群聊看 groupSequence(11)，私聊/临时会话看 privateSequence(14)。
 */
export const SEND_MESSAGE_RESPONSE: ProtoMessage = message([
  f('result', 1, 'int32'),
  f('errMsg', 2, 'string'),
  f('timestamp1', 3, 'uint32'),
  f('field10', 10, 'uint32'),
  f('groupSequence', 11, 'uint32'),
  f('timestamp2', 12, 'uint32'),
  f('privateSequence', 14, 'uint32'),
]);

// ---------- 发送向 pbElem ----------
//
// 这几个 pbElem 的父容器都是收侧已有的 COMMON_ELEM(serviceType/pbElem/businessType)，
// 只有内容结构是发送方向才会构造。

/** 普通小黄脸（commonElem serviceType=33）的 pbElem。 */
export const QSMALL_FACE_EXTRA: ProtoMessage = message([
  f('faceId', 1, 'uint32'),
  f('preview', 2, 'string'),
  f('preview2', 3, 'string'),
]);

/**
 * 超级/动态表情（commonElem serviceType=37）的 pbElem。
 *
 * packId / stickerId / stickerType 来自系统表情目录（0x9154_1），拿不到时不要走
 * 这条 —— 把动态表情按老 FaceElem 发出去会被服务端静默改写成另一张脸
 * （SnowLuma issue #168）。本包不内置目录，由调用方传入。
 */
export const QFACE_EXTRA: ProtoMessage = message([
  f('packId', 1, 'string'),
  f('stickerId', 2, 'string'),
  f('qsid', 3, 'int32'),
  f('sourceType', 4, 'int32'),
  f('stickerType', 5, 'int32'),
  f('resultId', 6, 'string'),
  f('text', 7, 'string'),
  f('randomType', 9, 'int32'),
]);

/** 私聊窗口抖动（commonElem serviceType=2）的 pbElem。 */
export const POKE_EXTRA: ProtoMessage = message([f('type', 1, 'uint32')]);

/** 商城表情 MarketFace.pbReserve(13) 的内层：发送时置 field8=1（动画标记）。 */
export const MARKET_FACE_PB_RESERVE: ProtoMessage = message([f('field8', 8, 'uint32')]);

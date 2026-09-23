// OIDB 0xdc2_34 — 发送自定义图文 (URL-share) Ark 卡片到私聊/群聊。
// 移植自 SnowLuma packages/protocol/src/oidb-services/contacts/send-tuwen-ark.ts
// (由 QQ Android 9.3.25 抓包 RE 得到)。默认 SSO: OidbSvcTrpcTcp.0xdc2_34。
//
// 固定字段: appId = 100446242, field2 = 1, field3 = 0, field5 = {1:1}。
// targetId 同时出现在 AppInfo[11] 与 Meta[2]; Meta.peerType: 0 = C2C, 1 = 群聊。
// peerType / field3 / previewUrl 是 pb_optional —— 0/空值也要上 wire(force)。
// 响应里没有 message_id(不可撤回/设精华),但**不是**空 ack:服务端会把
// 「消息下发结果」放在 body 的 result(1) 里,下发失败时 OIDB 外层 errorCode
// 仍为 0 —— 只看外层会静默假成功。这里如实解出 result.errorCode(4) /
// result.errorMessage(5) 并在 invoke 结果里返回,由调用方判定成功与否。

import { message } from '../protobuf';
import type { OidbNative } from '../transport';
import { invokeOidb, type OidbSpec } from './invoke';
import { toInt } from './shared';

/** 图文 Ark 固定 appId。 */
const TUWEN_ARK_APPID = 100446242;

/** AppInfo.f5 = {1:1}。 */
const TUWEN_ARK_FIELD5 = message([{ name: 'field1', tag: 1, type: 'uint32' }]);

/** AppInfo.f12 — 卡片正文。 */
const TUWEN_ARK_CONTENT = message([
  { name: 'flag', tag: 1, type: 'uint32' },
  { name: 'title', tag: 10, type: 'string' },
  { name: 'desc', tag: 11, type: 'string' },
  { name: 'summary', tag: 12, type: 'string' },
  { name: 'jumpUrl', tag: 13, type: 'string' },
  { name: 'previewUrl', tag: 14, type: 'string', force: true },
]);

/** 请求 f1 — AppInfo。 */
const TUWEN_ARK_APP_INFO = message([
  { name: 'appId', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32', force: true },
  { name: 'field5', tag: 5, type: TUWEN_ARK_FIELD5 },
  { name: 'targetId', tag: 11, type: 'uint32' },
  { name: 'content', tag: 12, type: TUWEN_ARK_CONTENT },
]);

/** 请求 f2 — Meta。 */
const TUWEN_ARK_META = message([
  { name: 'peerType', tag: 1, type: 'uint32', force: true },
  { name: 'targetId', tag: 2, type: 'uint32' },
]);

const TUWEN_ARK_REQ = message([
  { name: 'appInfo', tag: 1, type: TUWEN_ARK_APP_INFO },
  { name: 'meta', tag: 2, type: TUWEN_ARK_META },
]);

/** result.f6 — 失败详情(下发失败时的中文文案 + 错误来源)。 */
const TUWEN_ARK_DETAIL = message([
  { name: 'message', tag: 1, type: 'string' },
  { name: 'source', tag: 6, type: 'string' },
]);

/** body.f1 — 下发结果。errorCode=0 才是真的发出去了。 */
const TUWEN_ARK_RESULT = message([
  { name: 'peerType', tag: 1, type: 'uint32' },
  { name: 'targetId', tag: 2, type: 'uint32' },
  { name: 'errorCode', tag: 4, type: 'uint32' },
  { name: 'errorMessage', tag: 5, type: 'string' },
  { name: 'detail', tag: 6, type: TUWEN_ARK_DETAIL },
]);

/** 响应 body:result(1)。字段全为 0/空时,wire 上就是一个空 body。 */
const TUWEN_ARK_RESP = message([{ name: 'result', tag: 1, type: TUWEN_ARK_RESULT }]);

export interface SendTuwenArkParams {
  /** 目标 QQ 号(peerType=0)或群号(peerType=1)。 */
  targetId: number;
  /** 0 = 私聊(C2C),1 = 群聊。 */
  peerType: 0 | 1;
  title: string;
  desc: string;
  summary: string;
  jumpUrl: string;
  previewUrl: string;
}

/** 下发结果(服务端回显)。errorCode 非 0 表示服务端拒绝下发,调用方必须检查。 */
export interface SendTuwenArkResult {
  /** 0 = C2C, 1 = 群聊。 */
  peerType: number;
  /** 回显目标 QQ 号 / 群号。 */
  targetId: number;
  /**
   * 服务端下发结果码。0 = 已下发。
   *
   * 已知非 0: **901501** —— 该 appId(100446242)是 Android 端图文卡片的
   * appId,PC/Linux 端当前不被 imagent 的 rule type 接受,服务端会回
   * `rule type not match appid`。详见 `docs/develop/ark-send.md`。
   */
  errorCode: number;
  /** 服务端错误描述(errorCode 非 0 时有意义)。 */
  errorMessage: string;
  /** 失败详情(中文文案 + 错误来源),成功时为 undefined。 */
  detail?: { message: string; source: string };
}

export namespace SendTuwenArk {
  export const command = 0xdc2;
  export const subCommand = 34;
  export const reqSchema = TUWEN_ARK_REQ;
  export const respSchema = TUWEN_ARK_RESP;

  /** 下发是否真的成功(errorCode === 0)。 */
  export const isOk = (result: SendTuwenArkResult): boolean => result.errorCode === 0;

  export const serialize = (p: SendTuwenArkParams): Record<string, unknown> => ({
    appInfo: {
      appId: TUWEN_ARK_APPID,
      field2: 1,
      field3: 0,
      field5: { field1: 1 },
      targetId: p.targetId,
      content: {
        flag: 1,
        title: p.title,
        desc: p.desc,
        summary: p.summary,
        jumpUrl: p.jumpUrl,
        previewUrl: p.previewUrl,
      },
    },
    meta: {
      peerType: p.peerType,
      targetId: p.targetId,
    },
  });

  /**
   * 解析下发结果。**不会静默**:外层 OIDB errorCode=0 也可能下发失败,
   * 所以这里把 body.result.errorCode(及其文案)原样返回,调用方必须检查
   * {@link isOk} —— 不要再自己假设「能进来就是成功」。
   */
  export const deserialize = (body: Record<string, unknown>): SendTuwenArkResult => {
    const result = (body.result ?? {}) as Record<string, unknown>;
    const detail = (result.detail ?? {}) as Record<string, unknown>;
    const errorCode = toInt(result.errorCode);
    const detailMessage = typeof detail.message === 'string' ? detail.message : '';
    const detailSource = typeof detail.source === 'string' ? detail.source : '';
    const errorMessage =
      (typeof result.errorMessage === 'string' && result.errorMessage) || detailMessage || '';
    return {
      peerType: toInt(result.peerType),
      targetId: toInt(result.targetId),
      errorCode,
      errorMessage,
      ...(errorCode !== 0
        ? { detail: { message: detailMessage || errorMessage, source: detailSource } }
        : {}),
    };
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: SendTuwenArkParams,
  ): Promise<SendTuwenArkResult> =>
    invokeOidb(nt, pid, SendTuwenArk as OidbSpec<SendTuwenArkParams, SendTuwenArkResult>, params);
}

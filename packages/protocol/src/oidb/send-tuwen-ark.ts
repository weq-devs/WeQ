// OIDB 0xdc2_34 — 发送自定义图文 (URL-share) Ark 卡片到私聊/群聊。
// 移植自 SnowLuma packages/protocol/src/oidb-services/contacts/send-tuwen-ark.ts
// (由 QQ Android 9.3.25 抓包 RE 得到)。默认 SSO: OidbSvcTrpcTcp.0xdc2_34。
//
// 固定字段: appId = 100446242, field2 = 1, field3 = 0, field5 = {1:1}。
// targetId 同时出现在 AppInfo[11] 与 Meta[2]; Meta.peerType: 0 = C2C, 1 = 群聊。
// peerType / field3 / previewUrl 是 pb_optional —— 0/空值也要上 wire(force)。
// 与 SendFlashMsg 类似,响应仅 ack,无 message_id(不可撤回/设精华)。

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

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

/** 响应为空(仅 OIDB envelope 的 errorCode=0 表示成功)。 */
const TUWEN_ARK_RESP = message([]);

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

export namespace SendTuwenArk {
  export const command = 0xdc2;
  export const subCommand = 34;
  export const reqSchema = TUWEN_ARK_REQ;
  export const respSchema = TUWEN_ARK_RESP;

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

  export const deserialize = (_body: Record<string, unknown>): void => {
    // 响应仅 ack,无业务字段。
  };

  export const invoke = (nt: OidbNative, pid: number, params: SendTuwenArkParams): Promise<void> =>
    invokeOidb(nt, pid, SendTuwenArk as OidbSpec<SendTuwenArkParams, void>, params);
}

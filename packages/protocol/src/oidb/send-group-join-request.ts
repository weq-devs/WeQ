// OIDB 0x11ec_1 —— 发送「入群申请」（加群请求）。
//
// 由真机抓包（2026-10-15）逆向 + 真机实发验证得到。外层是通用 OIDB 信封
// （native 负责 command/subCommand 包裹），`body` 里再套一层：
//
//   body:
//     f1  groupCode   uint64  群号（抓包 142598355）
//     f2  request     { … 见下 … }
//
//   request（字段号与抓包逐字节对齐）：
//     f1  fixed=1     uint32  （实测恒为 1）
//     f2  sourceId    uint32  来源标识，实测恒为 4001
//     f3  answer      string  入群回答（自动进群问题的答案）；可以为空，但字段恒上 wire
//     f4  richMsg     string  灰条富文本 XML（见下），服务端不校验内容
//     f5  authKey     string  申请鉴权串：64 个 ASCII 字符的 base64（解出 48 字节）
//     f6  empty       message 空 message，实测恒出现（`32 00`）
//     f7  empty       message 空 message，实测恒出现（`3a 00`）
//     f8  empty       message 空 message，实测恒出现（`42 00`）
//
//   ⚠️ authKey（f5）**必填**，且由调用方提供 —— 它不是随便一个随机串，服务端按值校验：
//      - 值有效  → 申请被接受，回包是空 body（`inner f2` 为空）；
//      - 值无效 / 全零 → 服务端把流程降级为「短信安全验证」，回包里带一条
//        `https://ti.qq.com/hybrid-h5/secure_check/sms?...&type=sms&src=group&tk=…` 链接。
//     这条 48 字节 blob 的生成算法不在本仓库内（由 QQ 客户端现场算出），
//     所以协议层只做透传：调用方拿到什么就填什么。
//
//   抓包样例（群号 142598355）：field3 = ""（空 answer），field4 = 下面那条「新人入群」模板，
//   field5 = `rBklRBfbSj5gfZ7fx9/48OnjUtROIC+kE13enEI09ndvwd9PWuRmseA2WjLoIVFU`。
//
//   实发对照（真机验证通过）：
//     - authKey 用抓包原值 / 另一个有效值 → 空 body，直接过；
//     - authKey 全零                      → 触发短信验证链接。
//
//   回包：
//     - 成功 = 空 body（native 侧 decode 出的 inner body 里只有个空的 f2），deserialize 返回 void；
//     - **失败不会走到 deserialize** —— native 的 `run_oidb_ex` 在 `reply.status != 0` 时直接抛错
//       （只留 status + msg，原始 body 被丢），与 SendGroupSignup 同款缺口。
//     - ⚠️ 注意「短信验证」不是错误码：它是 errorCode=0 的**成功**回包，body 里带挑战链接。
//       本 spec 按空 ack 处理（不解析 body），所以拿不到那条链接；需要识别它得另加 respSchema。

import { message } from '../protobuf';
import type { OidbNative } from '../transport';
import { invokeOidb, type OidbSpec } from './invoke';

/** 灰条富文本（f4）：服务端不校验内容，这里照抄抓包里的「新人入群」模板。 */
const JOIN_RICH_MSG =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<msg templateID="1" brief="" serviceID="104"><item layout="2">' +
  '<picture cover=""/><title>新人入群</title></item><source/></msg>';

/** 空 message：f6/f7/f8 用，抓包里恒出现为 `32 00` / `3a 00` / `42 00`。 */
const EMPTY = message([]);

/** request（body.f2）。 */
const JOIN_REQUEST = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'sourceId', tag: 2, type: 'uint32' },
  { name: 'answer', tag: 3, type: 'string', force: true },
  { name: 'richMsg', tag: 4, type: 'string' },
  { name: 'authKey', tag: 5, type: 'string' },
  { name: 'field6', tag: 6, type: EMPTY },
  { name: 'field7', tag: 7, type: EMPTY },
  { name: 'field8', tag: 8, type: EMPTY },
]);

/** body：f1 = groupCode，f2 = request。 */
const JOIN_BODY = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'request', tag: 2, type: JOIN_REQUEST },
]);

/** 回包：成功时为空 body，无字段可解（失败在 native 外层就抛了）。 */
const JOIN_RESP = message([]);

/** request.f1 的固定值（实测恒为 1）。 */
export const JOIN_REQUEST_FIELD1 = 1;
/** request.f2 的来源标识（实测恒为 4001）。 */
export const JOIN_REQUEST_SOURCE_ID = 4001;

export interface SendGroupJoinRequestParams {
  /** 目标群号。 */
  groupCode: number;
  /**
   * 入群回答（自动进群问题的答案）。可以为空 —— 空串也照抓包显式上 wire（`1a 00`）。
   */
  answer?: string;
  /**
   * 申请鉴权串（f5）：64 个 ASCII 字符的 base64（解出 48 字节）。
   *
   * **必填**，且必须由外部调用方提供 —— 服务端按值校验（无效值会降级成短信验证）。
   * 本仓库不生成它，只透传。
   */
  authKey: string;
}

export namespace SendGroupJoinRequest {
  /** SSO 命令 OidbSvcTrpcTcp.0x11ec_1。 */
  export const command = 0x11ec;
  export const subCommand = 1;
  /** 真机实发用签名（native D2Auth sign=true），照抓包标 true。 */
  export const needSign = true;
  export const reqSchema = JOIN_BODY;
  export const respSchema = JOIN_RESP;

  export type Params = SendGroupJoinRequestParams;

  export const serialize = (p: SendGroupJoinRequestParams): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupCode) || p.groupCode <= 0) {
      throw new Error(`groupCode 必须是正整数，收到 ${String(p.groupCode)}`);
    }
    if (typeof p.authKey !== 'string' || p.authKey.length === 0) {
      throw new Error('authKey（申请鉴权串）必填且不能为空');
    }
    return {
      groupCode: p.groupCode,
      request: {
        field1: JOIN_REQUEST_FIELD1,
        sourceId: JOIN_REQUEST_SOURCE_ID,
        answer: p.answer ?? '',
        richMsg: JOIN_RICH_MSG,
        authKey: p.authKey,
        field6: {},
        field7: {},
        field8: {},
      },
    };
  };

  /**
   * 成功 ack 无字段可解（`inner f2` 为空）。失败在 native 外层直接抛错，不走这里；
   * 「短信验证」虽然是 errorCode=0，但 body 里的挑战链接这里不解析（见文件头注释）。
   */
  export const deserialize = (_body: Record<string, unknown>): void => {};

  /** 发一条入群申请。需要已 attach 的在线 QQ 进程。 */
  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: SendGroupJoinRequestParams,
  ): Promise<void> =>
    invokeOidb(nt, pid, SendGroupJoinRequest as OidbSpec<SendGroupJoinRequestParams, void>, params);
}

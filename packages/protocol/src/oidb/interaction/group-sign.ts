// 群打卡 — 0xEB7_1。
//
// 请求：`signInInfo@2 { uin@1:string, groupId@2:string, version@3:"9.0.90" }`，回包空 ack。
// 搬运自 SnowLuma `oidb-services/misc/send-group-sign.ts`（与 NapCat `GroupSign` 一致）。
//
// 签名：LagrangeV2 白名单里没有 0xeb7 → 不签。
//
// ⚠️ 历史实现里 SnowLuma 用大写 `OidbSvcTrpcTcp.0xEB7_1`；native 固定输出小写
// `OidbSvcTrpcTcp.0xeb7_1`，SnowLuma 注释确认服务端两种都收。

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';

const GROUP_SIGN_INFO = message([
  { name: 'uin', tag: 1, type: 'string' },
  { name: 'groupId', tag: 2, type: 'string' },
  { name: 'version', tag: 3, type: 'string' },
]);
const GROUP_SIGN_REQ = message([{ name: 'signInInfo', tag: 2, type: GROUP_SIGN_INFO }]);
const GROUP_SIGN_RESP = message([]);

export interface SendGroupSignParams {
  groupId: number;
  /** 当前账号 uin。 */
  selfUin: number | string;
}

export namespace SendGroupSign {
  export const command = 0xeb7;
  export const subCommand = 1;
  export const reqSchema = GROUP_SIGN_REQ;
  export const respSchema = GROUP_SIGN_RESP;

  export type Params = SendGroupSignParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    const uin = String(p.selfUin ?? '').trim();
    if (!/^\d+$/.test(uin)) throw new Error(`selfUin 必须是数字字符串，收到 ${uin}`);
    return {
      signInInfo: { uin, groupId: String(p.groupId), version: '9.0.90' },
    };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SendGroupSign as OidbSpec<Params, void>, params);
}

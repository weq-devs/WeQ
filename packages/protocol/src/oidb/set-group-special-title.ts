// OIDB 0x8FC_2 —— 设置群成员专属头衔（群头衔）。
//
//   f1 groupUin   (uint32)  群号
//   f3 body       { f1 targetUid (string), f5 specialTitle (string),
//                   f6 expireTime (int32), f7 uinName (string) }
//
// `expireTime = -1` 是「永久」的 wire 常量。`uinName` 必须与 `specialTitle` 相同，
// 否则服务端会以 errorCode=0 接受请求但**静默不生效**。
//
// 搬运自 SnowLuma `oidb-services/group-admin/set-special-title.ts`。
//
// 签名：LagrangeV2 白名单里只有 0x8fc_3，没有 0x8fc_2，needSign = false。

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

/** 「永久」常量（wire 上就是 -1 的 int32）。 */
export const SPECIAL_TITLE_PERMANENT = -1;

const SPECIAL_TITLE_BODY = message([
  { name: 'targetUid', tag: 1, type: 'string' },
  { name: 'specialTitle', tag: 5, type: 'string' },
  { name: 'expireTime', tag: 6, type: 'int32' },
  { name: 'uinName', tag: 7, type: 'string' },
]);
const SPECIAL_TITLE_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'body', tag: 3, type: SPECIAL_TITLE_BODY },
]);

/** 回包是空 ack。 */
const SPECIAL_TITLE_RESP = message([]);

export interface SetGroupSpecialTitleParams {
  /** 群号。 */
  groupId: number;
  /** 目标成员的 NT uid。 */
  targetUid: string;
  /** 头衔文本；空串 = 清除。 */
  title: string;
  /** 过期时间（unix 秒）；缺省 = 永久（-1）。 */
  expireTime?: number;
}

export namespace SetGroupSpecialTitle {
  export const command = 0x8fc;
  export const subCommand = 2;
  export const needSign = false;
  export const reqSchema = SPECIAL_TITLE_REQ;
  export const respSchema = SPECIAL_TITLE_RESP;

  export type Params = SetGroupSpecialTitleParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    if (!p.targetUid) throw new Error('targetUid 不能为空');
    const expireTime = p.expireTime ?? SPECIAL_TITLE_PERMANENT;
    return {
      groupUin: p.groupId,
      body: {
        targetUid: p.targetUid,
        specialTitle: p.title,
        expireTime,
        // uinName 必须镜像 specialTitle，否则服务端静默不生效。
        uinName: p.title,
      },
    };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetGroupSpecialTitle as OidbSpec<Params, void>, params);
}

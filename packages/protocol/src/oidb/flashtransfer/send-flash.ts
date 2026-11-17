// OIDB 0x93d7_1 — 发送闪传文件给用户(send_flash_msg)。
// 请求 f1={f1:1, f2:{f1:targetUid}}, f2=filesetUuid(私聊);
//      f1={f1:2, f3:{f1:groupId}}, f2=filesetUuid(群聊)。响应逐目标返回状态,无 message_id。
// 0x93d7 是「分享 fileset 给用户」(对端通过 fileset 链接下载),非传统消息。

import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';
import { FLASH_SEND_REQ, FLASH_SEND_RESP } from './schemas';

export interface SendFlashMsgParams {
  /** 私聊目标 uid(与 groupId 二选一)。 */
  targetUid?: string;
  /** 群聊目标群号(与 targetUid 二选一)。 */
  groupId?: number;
  filesetUuid: string;
}

export namespace SendFlashMsg {
  export const command = 0x93d7;
  export const subCommand = 1;
  /** 真机实测会签名（scripts/probe-sign.ts）。 */
  export const reqSchema = FLASH_SEND_REQ;
  export const respSchema = FLASH_SEND_RESP;

  export const serialize = (p: SendFlashMsgParams): Record<string, unknown> => {
    if (p.groupId !== undefined) {
      return {
        target: { field1: 2, targetGroup: { groupId: p.groupId } },
        filesetUuid: p.filesetUuid,
      };
    }
    if (!p.targetUid) throw new Error('send_flash_msg: target_uid or group_id is required');
    return {
      target: { field1: 1, targetUid: { targetUid: p.targetUid } },
      filesetUuid: p.filesetUuid,
    };
  };

  export const deserialize = (body: Record<string, unknown>): void => {
    // Android 9.3.85 libkernel 的响应解码器：repeated tag 1 -> result(1)/msg(2)/target(3)。
    const statuses = body.sendStatus as
      | { result?: number; msg?: string; target?: unknown }[]
      | undefined;
    if (!statuses?.length) throw new Error('闪传分享未确认：服务端未返回目标发送状态。');
    for (const status of statuses) {
      const result = status.result ?? 0;
      if (result !== 0)
        throw new Error(`闪传分享失败（${result}）${status.msg ? `：${status.msg}` : ''}`);
      if (!status.target) throw new Error('闪传分享未确认：服务端未返回发送目标。');
    }
  };

  export const invoke = (nt: OidbNative, pid: number, params: SendFlashMsgParams): Promise<void> =>
    invokeOidb(nt, pid, SendFlashMsg as OidbSpec<SendFlashMsgParams, void>, params);
}

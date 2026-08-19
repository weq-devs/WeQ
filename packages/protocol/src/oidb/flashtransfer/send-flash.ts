// OIDB 0x93d7_1 — 发送闪传文件给用户(send_flash_msg)。
// 请求 f1={f1:1, f2:{f1:targetUid}}, f2=filesetUuid(私聊);
//      f1={f1:2, f3:{f1:groupId}}, f2=filesetUuid(群聊)。响应仅回显目标,无 message_id。
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

  export const deserialize = (_body: Record<string, unknown>): void => {
    // 响应仅回显目标 uid,无 message_id。
  };

  export const invoke = (nt: OidbNative, pid: number, params: SendFlashMsgParams): Promise<void> =>
    invokeOidb(nt, pid, SendFlashMsg as OidbSpec<SendFlashMsgParams, void>, params);
}

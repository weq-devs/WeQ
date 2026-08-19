// OIDB 0x93d1_1 — 设置 fileSet 状态。请求 f1=filesetUuid, f2=6(状态码)。响应 ack。sub=1, reserved=0。

import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';
import { FLASH_SET_STATUS_REQ, FLASH_SET_STATUS_RESP } from './schemas';

export interface SetFilesetStatusParams {
  filesetUuid: string;
  /** 默认 6。 */
  status?: number;
}

export namespace SetFilesetStatus {
  export const command = 0x93d1;
  export const subCommand = 1;
  export const reqSchema = FLASH_SET_STATUS_REQ;
  export const respSchema = FLASH_SET_STATUS_RESP;

  export const serialize = (p: SetFilesetStatusParams): Record<string, unknown> => ({
    filesetUuid: p.filesetUuid,
    status: p.status ?? 6,
  });

  export const deserialize = (_body: Record<string, unknown>): void => {
    // 成功靠 envelope errorCode=0。
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: SetFilesetStatusParams,
  ): Promise<void> =>
    invokeOidb(nt, pid, SetFilesetStatus as OidbSpec<SetFilesetStatusParams, void>, params);
}

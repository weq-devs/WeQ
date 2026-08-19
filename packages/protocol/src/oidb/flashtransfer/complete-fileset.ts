// OIDB 0x93db_1 — fileSet 完成。请求 f1=filesetUuid, f2="".响应 ack。sub=1, reserved=0。

import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';
import { FLASH_COMPLETE_FILESET_REQ, FLASH_COMPLETE_FILESET_RESP } from './schemas';

export interface CompleteFilesetParams {
  filesetUuid: string;
}

export namespace CompleteFileset {
  export const command = 0x93db;
  export const subCommand = 1;
  export const reqSchema = FLASH_COMPLETE_FILESET_REQ;
  export const respSchema = FLASH_COMPLETE_FILESET_RESP;

  export const serialize = (p: CompleteFilesetParams): Record<string, unknown> => ({
    filesetUuid: p.filesetUuid,
    field2: '',
  });

  export const deserialize = (_body: Record<string, unknown>): void => {
    // 成功靠 envelope errorCode=0。
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: CompleteFilesetParams,
  ): Promise<void> =>
    invokeOidb(nt, pid, CompleteFileset as OidbSpec<CompleteFilesetParams, void>, params);
}

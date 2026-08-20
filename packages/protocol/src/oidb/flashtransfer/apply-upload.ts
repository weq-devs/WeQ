// OIDB 0x12a9_103 — apply-upload(注册 fileId)。抓包时序在主文件上传之后、缩略图 sliceupload 之前。
// uinForm=true。带 MD5 + 客户端构造的 fileId。响应无 rkey(rkey 来自 sub=100)。

import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';
import { FLASH_FILE_ID_TTL_SECONDS, FLASH_FILE_ID_TTL_THUMB_SECONDS } from './file-id';
import { FLASH_APPLY_UPLOAD_REQ, FLASH_APPLY_UPLOAD_RESP } from './schemas';

export interface ApplyUploadParams {
  filesetUuid: string;
  fileUuid: string;
  fileId: string;
  fileName: string;
  fileSize: number;
  /** 32 hex。 */
  md5: string;
  /** 40 hex。 */
  sha1: string;
  fileIndex: number;
  formatCode: number;
  thumbType?: 'png' | 'jpg';
  width?: number;
  height?: number;
}

export namespace ApplyUpload {
  export const command = 0x12a9;
  export const subCommand = 103;
  export const uinForm = true;
  export const reqSchema = FLASH_APPLY_UPLOAD_REQ;
  export const respSchema = FLASH_APPLY_UPLOAD_RESP;

  let seqCounter = 100;

  export const serialize = (p: ApplyUploadParams): Record<string, unknown> => {
    // 缩略图与主文件字段差异:config.f103、FileInfo.f5.f1/f6/f7/f9、filesetWrap.f5/f6/f7。
    const isThumb = p.thumbType !== undefined;
    const isJpg = p.thumbType === 'jpg';
    return {
      head: {
        sub: { seq: seqCounter++, sub: 103 },
        config: {
          field101: 2,
          field102: 4,
          field103: isThumb ? (isJpg ? 24 : 23) : 22,
          field200: 5,
        },
        field3: { field1: 1 },
      },
      payload: {
        wrapper: {
          fileInfo: {
            fileSize: p.fileSize,
            md5: p.md5,
            sha1: p.sha1,
            fileName: p.fileName,
            field5: { field1: isJpg ? 1 : 0, field2: 0, field3: 0, field4: 0 },
            field6: p.width ?? 0,
            field7: p.height ?? 0,
            field8: 0,
            field9: isJpg ? 0 : 1,
          },
          fileId: p.fileId,
          field3: 1,
          field4: Math.floor(Date.now() / 1000),
          field5: isThumb ? FLASH_FILE_ID_TTL_THUMB_SECONDS : FLASH_FILE_ID_TTL_SECONDS,
          field6: 0,
        },
        flag2: { field1: 2 },
        field3: { field1: 0, field2: 0, field3: 0, field4: {} },
        filesetWrap: {
          filesetUuid: p.filesetUuid,
          uploadKey: p.filesetUuid,
          fileUuid: p.fileUuid,
          field4: p.fileIndex,
          field5: isThumb && !isJpg ? 1 : 0,
          field6: isThumb ? (isJpg ? 1 : 0) : 0,
          field7: isThumb ? (isJpg ? 2 : 26) : p.formatCode,
          field8: {},
          field9: 1,
          field10: 0,
          field11: 0,
          field12: 0,
          field13: 0,
          field14: 0,
        },
      },
    };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {
    // sub=103 响应无 rkey(仅确认注册),成功靠 envelope errorCode=0。
  };

  export const invoke = (nt: OidbNative, pid: number, params: ApplyUploadParams): Promise<void> =>
    invokeOidb(nt, pid, ApplyUpload as OidbSpec<ApplyUploadParams, void>, params);
}

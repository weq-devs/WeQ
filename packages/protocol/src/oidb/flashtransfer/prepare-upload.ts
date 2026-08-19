// OIDB 0x12a9_100 — prepare-upload(大文件分片上传前申请 sliceupload rkey)。
// sub=100,uinForm=true。sub=100 的 payload 在 f2(sub=103 在 f12),结构完全不同。
// 响应 f2.f1 是 sliceupload rkey;秒传(文件已在服务端)时 f1 缺失,deserialize 返回 null。

import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';
import { FLASH_PREPARE_UPLOAD_REQ, FLASH_PREPARE_UPLOAD_RESP } from './schemas';

export interface PrepareUploadParams {
  filesetUuid: string;
  fileUuid: string;
  fileName: string;
  fileSize: number;
  /** 40 hex。 */
  sha1: string;
  /** fileset 内序号(1,2,3...),与 0x93d0 commit f6 一致。 */
  fileIndex: number;
  /** 格式码:与 commit f7 一致(mp4=2, rar/zip=4)。 */
  formatCode: number;
  /** 缩略图类型:undefined=主文件, 'png'=png 缩略图, 'jpg'=jpg 缩略图。 */
  thumbType?: 'png' | 'jpg';
  width?: number;
  height?: number;
}

export namespace PrepareUpload {
  export const command = 0x12a9;
  export const subCommand = 100;
  export const uinForm = true;
  export const reqSchema = FLASH_PREPARE_UPLOAD_REQ;
  export const respSchema = FLASH_PREPARE_UPLOAD_RESP;

  let seqCounter = 200;

  export const serialize = (p: PrepareUploadParams): Record<string, unknown> => {
    // 缩略图与主文件字段差异:config.f103、FileInfo.f5.f1/f6/f7/f9、filesetWrap.f6/f7。
    const isThumb = p.thumbType !== undefined;
    const isJpg = p.thumbType === 'jpg';
    return {
      head: {
        sub: { seq: seqCounter++, sub: 100 },
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
            md5: '',
            sha1: p.sha1,
            fileName: p.fileName,
            field5: { field1: isJpg ? 1 : 0, field2: 0, field3: 0, field4: 0 },
            field6: p.width ?? 0,
            field7: p.height ?? 0,
            field8: 0,
            field9: isJpg ? 0 : 1,
          },
          field2: 0,
        },
        field2: 1,
        field3: 0,
        field4: 0,
        field5: 0,
        field6: {
          field1: { field1: 0, field2: {} },
          field2: { field3: {} },
          field3: { field11: {}, field12: {} },
          field10: 0,
        },
        field7: 0,
        field8: 0,
        filesetWrap: {
          filesetUuid: p.filesetUuid,
          uploadKey: p.filesetUuid,
          fileUuid: p.fileUuid,
          field4: p.fileIndex,
          field5: 0,
          field6: isThumb ? 1 : 0,
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

  export const deserialize = (body: Record<string, unknown>): string | null => {
    // sub=100 响应 f2={f1:rkey}(正常上传)。秒传时 f2 无 f1,返回 null 跳过 sliceupload。
    const rkey = (body.rkeyWrap as Record<string, unknown> | undefined)?.rkey;
    return typeof rkey === 'string' && rkey ? rkey : null;
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: PrepareUploadParams,
  ): Promise<string | null> =>
    invokeOidb(nt, pid, PrepareUpload as OidbSpec<PrepareUploadParams, string | null>, params);
}

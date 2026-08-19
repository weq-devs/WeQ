// OIDB 0x93cf_1 — 申请创建 fileSet(闪传上传起点)。
// 请求 f1=1, f2=FileInfo{fileName,origName,fileType=1,size,uploader}, f3=类型码, f12=1。
// 响应 f1=filesetUuid, f2=uploadKey(同 f1), f3=上传/分享 URL(qfile.qq.com/q/<code>),
// f4=expire, f5=ttl。subCommand=1, reserved=0。

import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';
import { FLASH_APPLY_FILESET_REQ, FLASH_APPLY_FILESET_RESP } from './schemas';

export interface FlashUploaderInfo {
  uin: string;
  nickname: string;
  uid: string;
}

export interface ApplyFilesetParams {
  fileName: string;
  origName: string;
  fileSize: number;
  /** 文件类型码:rar=2, png/mp4=7。 */
  typeCode: number;
  uploader: FlashUploaderInfo;
}

export interface ApplyFilesetResult {
  filesetUuid: string;
  uploadKey: string;
  /** 上传/分享链接 https://qfile.qq.com/q/<code>。 */
  uploadUrl: string;
  expire: number;
  ttl: number;
}

export namespace ApplyFileset {
  export const command = 0x93cf;
  export const subCommand = 1;
  export const reqSchema = FLASH_APPLY_FILESET_REQ;
  export const respSchema = FLASH_APPLY_FILESET_RESP;

  export const serialize = (p: ApplyFilesetParams): Record<string, unknown> => ({
    field1: 1,
    fileInfo: {
      fileName: p.fileName,
      origName: p.origName,
      fileType: 1,
      fileSize: BigInt(p.fileSize),
      uploader: {
        uin: p.uploader.uin,
        nickname: p.uploader.nickname,
        uid: p.uploader.uid,
        field4: {},
      },
      field16: 1,
      field20: 0,
      field21: 0,
    },
    typeCode: p.typeCode,
    field12: 1,
  });

  export const deserialize = (body: Record<string, unknown>): ApplyFilesetResult => {
    const filesetUuid = typeof body.filesetUuid === 'string' ? body.filesetUuid : '';
    if (!filesetUuid) throw new Error('apply fileset failed: missing fileset_uuid');
    return {
      filesetUuid,
      uploadKey: typeof body.uploadKey === 'string' ? body.uploadKey : '',
      uploadUrl: typeof body.uploadUrl === 'string' ? body.uploadUrl : '',
      expire: toInt(body.expire),
      ttl: toInt(body.ttl),
    };
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: ApplyFilesetParams,
  ): Promise<ApplyFilesetResult> =>
    invokeOidb(nt, pid, ApplyFileset as OidbSpec<ApplyFilesetParams, ApplyFilesetResult>, params);
}

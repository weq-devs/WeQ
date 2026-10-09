// OIDB 0x93cf_1 — 申请创建 fileSet(闪传上传起点)。
// 请求 f1=1, f2=FileInfo{fileName,origName,fileType=1,size,uploader,...}, f3=上传场景码, f4=有效期。
// 响应 f1=filesetUuid, f2=uploadKey(同 f1), f3=上传/分享 URL(qfile.qq.com/q/<code>),
// f4=expire, f5=ttl。subCommand=1, reserved=0。
//
// 实机抓包(2026-10)确认: f3 是**上传场景码**(同 NapCat 的 uploadSceneType,
// AIO 文件选择器 = 10),不是文件类型;f4 是有效期秒数(新内核要求,缺失会失败)。

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
  /** 上传场景码(实机 AIO 文件选择器 = 10)。 */
  uploadSceneType: number;
  /** 文件集有效期(秒)。缺省 1209600(14 天);可选 90/180 天。 */
  validitySeconds?: number;
  uploader: FlashUploaderInfo;
}

/** 闪传文件集默认有效期(14 天),与 NapCat DEFAULT_FLASH_VALIDITY_SECONDS 一致。 */
export const FLASH_DEFAULT_VALIDITY_SECONDS = 1209600;

/** NapCat/PCQQ 默认上传场景:AIO 文件选择器。 */
export const FLASH_UPLOAD_SCENE_AIO_FILE_SELECTOR = 10;

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
      field23: 0,
      field24: { field2: 0, field3: '' },
    },
    typeCode: p.uploadSceneType,
    validitySeconds: p.validitySeconds ?? FLASH_DEFAULT_VALIDITY_SECONDS,
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

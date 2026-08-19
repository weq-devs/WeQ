// OIDB 0x93d3_1 — 拉取文件集详情(点「分享」显示链接时触发)。
// 请求 f1=filesetUuid, f2=7。响应 f1=repeated FlashFileEntry(含文件名/大小/
// 上传分享 URL qfile.qq.com/q/<code> / fileId / 下载 URL)。
// 用于 get_fileset_info / get_flash_file_list / get_share_link。

import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';
import { FLASH_GET_DETAIL_REQ, FLASH_GET_DETAIL_RESP } from './schemas';

export interface FlashFileInfo {
  filesetUuid: string;
  fileName: string;
  origName: string;
  fileSize: number;
  /** 上传/分享链接 qfile.qq.com/q/<code>。 */
  shareUrl: string;
  fileId: string;
  /** 下载链接(URL 里已含 rkey)。 */
  downloadUrl: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export interface GetFilesetDetailParams {
  filesetUuid: string;
}

export namespace GetFilesetDetail {
  export const command = 0x93d3;
  export const subCommand = 1;
  export const reqSchema = FLASH_GET_DETAIL_REQ;
  export const respSchema = FLASH_GET_DETAIL_RESP;

  export const serialize = (p: GetFilesetDetailParams): Record<string, unknown> => ({
    filesetUuid: p.filesetUuid,
    field2: 7,
  });

  export const deserialize = (body: Record<string, unknown>): FlashFileInfo[] => {
    const entries = body.entries as Record<string, unknown>[] | undefined;
    if (!entries) return [];
    return entries.map((entry) => {
      const uploadUrlWrap = entry.uploadUrlWrap as Record<string, unknown> | undefined;
      const fileIdWrap = entry.fileIdWrap as Record<string, unknown> | undefined;
      const download = fileIdWrap?.download as Record<string, unknown> | undefined;
      return {
        filesetUuid: str(entry.filesetUuid),
        fileName: str(entry.fileName),
        origName: str(entry.origName),
        fileSize: toInt(entry.fileSize),
        shareUrl: str(uploadUrlWrap?.uploadUrl),
        fileId: str(fileIdWrap?.fileId),
        downloadUrl: str(download?.downloadUrl),
      };
    });
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: GetFilesetDetailParams,
  ): Promise<FlashFileInfo[]> =>
    invokeOidb(
      nt,
      pid,
      GetFilesetDetail as OidbSpec<GetFilesetDetailParams, FlashFileInfo[]>,
      params,
    );
}

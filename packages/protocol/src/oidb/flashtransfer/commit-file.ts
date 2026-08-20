// OIDB 0x93d0_1 — fileset 内所有文件的元数据上报(commit)。
// 多文件机制:f4 是 repeated,一个请求同时携带 fileset 内全部文件条目,
// 每条 f6=文件序号(1,2,3...),f7=formatCode。单文件时只有一个条目。
// 响应 f1=1(ack), f2/f3=filesetUuid。subCommand=1, reserved=0。

import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';
import { FLASH_COMMIT_FILE_REQ, FLASH_COMMIT_FILE_RESP } from './schemas';

export interface CommitEntry {
  fileUuid: string;
  fileName: string;
  origName: string;
  fileSize: number;
  /** 格式码:rar=4, mp4=2。 */
  formatCode: number;
  /** fileset 内序号(1,2,3...),与 0x12a9 filesetWrap.f4 一致。 */
  fileIndex: number;
}

export interface CommitFileParams {
  filesetUuid: string;
  /** fileset 内全部文件条目;一次 0x93d0 请求同时上报。 */
  entries: CommitEntry[];
}

export interface CommitFileResult {
  filesetUuid: string;
}

export namespace CommitFile {
  export const command = 0x93d0;
  export const subCommand = 1;
  export const reqSchema = FLASH_COMMIT_FILE_REQ;
  export const respSchema = FLASH_COMMIT_FILE_RESP;

  export const serialize = (p: CommitFileParams): Record<string, unknown> => ({
    field1: 1,
    filesetUuid: p.filesetUuid,
    uploadKey: p.filesetUuid,
    commitInfo: p.entries.map((entry) => ({
      filesetUuid: p.filesetUuid,
      fileUuid: entry.fileUuid,
      field3: 0,
      field4: {},
      field5: 1,
      field6: entry.fileIndex,
      formatCode: entry.formatCode,
      fileName: entry.fileName,
      origName: entry.origName,
      field10: 0,
      fileSize: BigInt(entry.fileSize),
      field12: 0,
      field24: {},
    })),
    field5: 1,
    field6: 1,
  });

  export const deserialize = (body: Record<string, unknown>): CommitFileResult => ({
    filesetUuid: typeof body.filesetUuid === 'string' ? body.filesetUuid : '',
  });

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: CommitFileParams,
  ): Promise<CommitFileResult> =>
    invokeOidb(nt, pid, CommitFile as OidbSpec<CommitFileParams, CommitFileResult>, params);
}

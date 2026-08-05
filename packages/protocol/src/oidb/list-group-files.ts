// 群文件列表 — 0x6D8_1。一次一页,调用方按 startIndex 循环到 isEnd。
// 每页混着文件(type=1)和文件夹(type=2),这里拆成两个数组返回。

import { OIDB_GROUP_FILE_LIST_VIEW_REQ, OIDB_GROUP_FILE_LIST_VIEW_RESP } from './media-schemas';
import { invokeOidb, type OidbSpec } from './invoke';
import { ensureRetCodeZero, toInt } from './shared';
import type { OidbNative } from '../transport';

export interface GroupFileItem {
  fileId: string;
  fileName: string;
  fileSize: number;
  busId: number;
  uploadedTime: number;
  expireTime: number;
  modifiedTime: number;
  downloadedTimes: number;
  uploaderUin: number;
  uploaderName: string;
  parentDirectory: string;
}

export interface GroupFolderItem {
  folderId: string;
  parentDirectoryId: string;
  folderName: string;
  createTime: number;
  modifiedTime: number;
  creatorUin: number;
  creatorName: string;
  totalFileCount: number;
}

export interface GroupFilePage {
  files: GroupFileItem[];
  folders: GroupFolderItem[];
  isEnd: boolean;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export namespace ListGroupFiles {
  export const command = 0x6d8;
  export const subCommand = 1;
  export const uinForm = true;
  export const reqSchema = OIDB_GROUP_FILE_LIST_VIEW_REQ;
  export const respSchema = OIDB_GROUP_FILE_LIST_VIEW_RESP;

  export interface Params {
    groupId: number;
    /** 目标目录:根目录用 '/',子目录用 folderId。 */
    targetDirectory: string;
    startIndex: number;
    pageSize: number;
  }

  export const serialize = (p: Params): Record<string, unknown> => ({
    list: {
      groupUin: p.groupId,
      appId: 7,
      targetDirectory: p.targetDirectory || '/',
      fileCount: p.pageSize,
      sortBy: 1,
      startIndex: p.startIndex,
      field17: 2,
      field18: 0,
    },
  });

  export const deserialize = (body: Record<string, unknown>): GroupFilePage => {
    const list = body.list as Record<string, unknown> | undefined;
    // 服务端在流末尾会整个省略 list —— 当作空的最后一页。
    if (!list) return { files: [], folders: [], isEnd: true };
    ensureRetCodeZero('group file list', list.retCode, list.retMsg, list.clientWording);

    const files: GroupFileItem[] = [];
    const folders: GroupFolderItem[] = [];

    for (const raw of (list.items as Record<string, unknown>[] | undefined) ?? []) {
      const type = toInt(raw.type);
      if (type === 1 && raw.fileInfo) {
        const f = raw.fileInfo as Record<string, unknown>;
        files.push({
          fileId: str(f.fileId),
          fileName: str(f.fileName),
          fileSize: toInt(f.fileSize),
          busId: toInt(f.busId),
          uploadedTime: toInt(f.uploadedTime),
          expireTime: toInt(f.expireTime),
          modifiedTime: toInt(f.modifiedTime),
          downloadedTimes: toInt(f.downloadedTimes),
          uploaderUin: toInt(f.uploaderUin),
          uploaderName: str(f.uploaderName),
          parentDirectory: str(f.parentDirectory),
        });
      } else if (type === 2 && raw.folderInfo) {
        const d = raw.folderInfo as Record<string, unknown>;
        folders.push({
          folderId: str(d.folderId),
          parentDirectoryId: str(d.parentDirectoryId),
          folderName: str(d.folderName),
          createTime: toInt(d.createTime),
          modifiedTime: toInt(d.modifiedTime),
          creatorUin: toInt(d.creatorUin),
          creatorName: str(d.creatorName),
          totalFileCount: toInt(d.totalFileCount),
        });
      }
    }

    return { files, folders, isEnd: list.isEnd === true };
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<GroupFilePage> =>
    invokeOidb(nt, pid, ListGroupFiles as OidbSpec<Params, GroupFilePage>, params);
}

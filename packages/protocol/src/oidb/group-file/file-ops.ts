// 群文件 / 文件夹的增删改 — 0x6D6_3/4/5、0x6D7_0/1/2，以及 0x6D8_2/3。
//
// 搬运自 SnowLuma `oidb-services/group-file/{delete,move,rename}-group-file.ts` /
// `*-group-folder.ts` / `get-group-file-{count,space}.ts`。
//
// 签名：LagrangeV2 白名单里只有 0x6d6_2 / 0x6d6_3 / 0x6d9_2 / 0x6d9_4；0x6D7 在
// 名单里只有 `OidbSvc.` 写法（native 发 `OidbSvcTrpcTcp.`，实际不命中），0x6D8 一个
// 都没有。所以除 `DeleteGroupFile`（0x6d6_3）外全部不签 —— 交给 `invokeOidb` 按
// 白名单自动推导，以下只在需要显式覆盖时标注。
//
// 所有 `uinForm = true`：群文件这一族在 NTQQ 里走 UIN 形态的 OIDB 信封。

import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';
import {
  OIDB_GROUP_FILE_COUNT_VIEW_REQ,
  OIDB_GROUP_FILE_COUNT_VIEW_RESP,
  OIDB_GROUP_FILE_DELETE_REQ_VIEW,
  OIDB_GROUP_FILE_DELETE_RESP,
  OIDB_GROUP_FILE_MOVE_REQ_VIEW,
  OIDB_GROUP_FILE_MOVE_RESP,
  OIDB_GROUP_FILE_RENAME_REQ_VIEW,
  OIDB_GROUP_FILE_RENAME_RESP,
  OIDB_GROUP_FILE_SPACE_VIEW_REQ,
  OIDB_GROUP_FILE_SPACE_VIEW_RESP,
  OIDB_GROUP_FOLDER_CREATE_REQ_VIEW,
  OIDB_GROUP_FOLDER_CREATE_RESP,
  OIDB_GROUP_FOLDER_DELETE_REQ_VIEW,
  OIDB_GROUP_FOLDER_DELETE_RESP,
  OIDB_GROUP_FOLDER_RENAME_REQ_VIEW,
  OIDB_GROUP_FOLDER_RENAME_RESP,
} from '../file-upload-schemas';
import { ensureRetCodeZero, toInt } from '../shared';

/** 群文件业务号（列表 / 上传 / 下载 / 增删改统一 102）。 */
const GROUP_FILE_BUS_ID = 102;
/** 群文件应用号：移动用 7（与 SnowLuma 一致）。 */
const GROUP_FILE_APP_ID = 7;

function requireGroupId(groupId: number): number {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error(`groupId 必须是正整数，收到 ${String(groupId)}`);
  }
  return groupId;
}

function requireFileId(fileId: string): string {
  const text = String(fileId ?? '').trim();
  if (!text) throw new Error('fileId 不能为空');
  return text;
}

// ───────────────────────── 删除文件 — 0x6D6_3 ─────────────────────────

export interface DeleteGroupFileParams {
  groupId: number;
  fileId: string;
}

export namespace DeleteGroupFile {
  export const command = 0x6d6;
  export const subCommand = 3;
  export const uinForm = true;
  export const reqSchema = OIDB_GROUP_FILE_DELETE_REQ_VIEW;
  export const respSchema = OIDB_GROUP_FILE_DELETE_RESP;

  export type Params = DeleteGroupFileParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    delete: {
      groupUin: requireGroupId(p.groupId),
      busId: GROUP_FILE_BUS_ID,
      fileId: requireFileId(p.fileId),
    },
  });

  export const deserialize = (body: Record<string, unknown>): void => {
    const result = body.delete as Record<string, unknown> | undefined;
    if (!result) throw new Error('群文件删除响应缺少 delete');
    ensureRetCodeZero('群文件删除', result.retCode, result.retMsg, result.clientWording);
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, DeleteGroupFile as OidbSpec<Params, void>, params);
}

// ───────────────────────── 重命名文件 — 0x6D6_4 ─────────────────────────

export interface RenameGroupFileParams {
  groupId: number;
  fileId: string;
  /** 文件当前所在目录（`/` 表示根目录）。 */
  parentDirectory: string;
  newFileName: string;
}

export namespace RenameGroupFile {
  export const command = 0x6d6;
  export const subCommand = 4;
  export const uinForm = true;
  export const reqSchema = OIDB_GROUP_FILE_RENAME_REQ_VIEW;
  export const respSchema = OIDB_GROUP_FILE_RENAME_RESP;

  export type Params = RenameGroupFileParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const name = String(p.newFileName ?? '').trim();
    if (!name) throw new Error('newFileName 不能为空');
    return {
      rename: {
        groupUin: requireGroupId(p.groupId),
        busId: GROUP_FILE_BUS_ID,
        fileId: requireFileId(p.fileId),
        parentFolder: p.parentDirectory || '/',
        newFileName: name,
      },
    };
  };

  export const deserialize = (body: Record<string, unknown>): void => {
    const result = body.rename as Record<string, unknown> | undefined;
    if (!result) throw new Error('群文件重命名响应缺少 rename');
    ensureRetCodeZero('群文件重命名', result.retCode, result.retMsg, result.clientWording);
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, RenameGroupFile as OidbSpec<Params, void>, params);
}

// ───────────────────────── 移动文件 — 0x6D6_5 ─────────────────────────

export interface MoveGroupFileParams {
  groupId: number;
  fileId: string;
  /** 文件当前所在目录。 */
  parentDirectory: string;
  /** 目标目录文件夹 id；根目录用 `/`。 */
  targetDirectory: string;
}

export namespace MoveGroupFile {
  export const command = 0x6d6;
  export const subCommand = 5;
  export const uinForm = true;
  export const reqSchema = OIDB_GROUP_FILE_MOVE_REQ_VIEW;
  export const respSchema = OIDB_GROUP_FILE_MOVE_RESP;

  export type Params = MoveGroupFileParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    move: {
      groupUin: requireGroupId(p.groupId),
      appId: GROUP_FILE_APP_ID,
      busId: GROUP_FILE_BUS_ID,
      fileId: requireFileId(p.fileId),
      parentDirectory: p.parentDirectory || '/',
      targetDirectory: p.targetDirectory || '/',
    },
  });

  export const deserialize = (body: Record<string, unknown>): void => {
    const result = body.move as Record<string, unknown> | undefined;
    if (!result) throw new Error('群文件移动响应缺少 move');
    ensureRetCodeZero('群文件移动', result.retCode, result.retMsg, result.clientWording);
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, MoveGroupFile as OidbSpec<Params, void>, params);
}

// ───────────────────────── 新建文件夹 — 0x6D7_0 ─────────────────────────

export interface CreateGroupFolderParams {
  groupId: number;
  /** 父目录：根目录用 `/`，子目录用父文件夹 id。 */
  parentId: string;
  folderName: string;
}

export interface CreatedGroupFolder {
  folderId: string;
  folderName: string;
  folderPath: string;
  createTime: number;
  modifyTime: number;
  createUin: number;
  modifyUin: number;
}

export namespace CreateGroupFolder {
  export const command = 0x6d7;
  export const subCommand = 0;
  export const uinForm = true;
  export const reqSchema = OIDB_GROUP_FOLDER_CREATE_REQ_VIEW;
  export const respSchema = OIDB_GROUP_FOLDER_CREATE_RESP;

  export type Params = CreateGroupFolderParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const name = String(p.folderName ?? '').trim();
    if (!name) throw new Error('folderName 不能为空');
    return {
      create: {
        groupUin: requireGroupId(p.groupId),
        rootDirectory: p.parentId || '/',
        folderName: name,
      },
    };
  };

  export const deserialize = (body: Record<string, unknown>): CreatedGroupFolder => {
    const result = body.create as Record<string, unknown> | undefined;
    if (!result) throw new Error('群文件夹新建响应缺少 create');
    ensureRetCodeZero('群文件夹新建', result.retCode, result.retMsg, result.clientWording);
    const info = (result.folderInfo ?? {}) as Record<string, unknown>;
    return {
      folderId: typeof info.folderId === 'string' ? info.folderId : '',
      folderName: typeof info.folderName === 'string' ? info.folderName : '',
      folderPath: typeof info.folderPath === 'string' ? info.folderPath : '',
      createTime: toInt(info.createTime),
      modifyTime: toInt(info.modifyTime),
      createUin: toInt(info.createUin),
      modifyUin: toInt(info.modifyUin),
    };
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: Params,
  ): Promise<CreatedGroupFolder> =>
    invokeOidb(nt, pid, CreateGroupFolder as OidbSpec<Params, CreatedGroupFolder>, params);
}

// ───────────────────────── 删除文件夹 — 0x6D7_1 ─────────────────────────

export interface DeleteGroupFolderParams {
  groupId: number;
  folderId: string;
}

export namespace DeleteGroupFolder {
  export const command = 0x6d7;
  export const subCommand = 1;
  export const uinForm = true;
  export const reqSchema = OIDB_GROUP_FOLDER_DELETE_REQ_VIEW;
  export const respSchema = OIDB_GROUP_FOLDER_DELETE_RESP;

  export type Params = DeleteGroupFolderParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    delete: {
      groupUin: requireGroupId(p.groupId),
      folderId: requireFileId(p.folderId),
    },
  });

  export const deserialize = (body: Record<string, unknown>): void => {
    const result = body.delete as Record<string, unknown> | undefined;
    if (!result) throw new Error('群文件夹删除响应缺少 delete');
    ensureRetCodeZero('群文件夹删除', result.retCode, result.retMsg, result.clientWording);
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, DeleteGroupFolder as OidbSpec<Params, void>, params);
}

// ───────────────────────── 重命名文件夹 — 0x6D7_2 ─────────────────────────

export interface RenameGroupFolderParams {
  groupId: number;
  folderId: string;
  newFolderName: string;
}

export namespace RenameGroupFolder {
  export const command = 0x6d7;
  export const subCommand = 2;
  export const uinForm = true;
  export const reqSchema = OIDB_GROUP_FOLDER_RENAME_REQ_VIEW;
  export const respSchema = OIDB_GROUP_FOLDER_RENAME_RESP;

  export type Params = RenameGroupFolderParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const name = String(p.newFolderName ?? '').trim();
    if (!name) throw new Error('newFolderName 不能为空');
    return {
      rename: {
        groupUin: requireGroupId(p.groupId),
        folderId: requireFileId(p.folderId),
        newFolderName: name,
      },
    };
  };

  export const deserialize = (body: Record<string, unknown>): void => {
    const result = body.rename as Record<string, unknown> | undefined;
    if (!result) throw new Error('群文件夹重命名响应缺少 rename');
    ensureRetCodeZero('群文件夹重命名', result.retCode, result.retMsg, result.clientWording);
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, RenameGroupFolder as OidbSpec<Params, void>, params);
}

// ───────────────────────── 文件数量 — 0x6D8_2 ─────────────────────────

export interface GroupFileCount {
  fileCount: number;
  /** 群的群文件上限（常见 1500）。 */
  maxCount: number;
  isFull: boolean;
}

export interface GetGroupFileCountParams {
  groupId: number;
}

export namespace GetGroupFileCount {
  export const command = 0x6d8;
  export const subCommand = 2;
  export const reqSchema = OIDB_GROUP_FILE_COUNT_VIEW_REQ;
  export const respSchema = OIDB_GROUP_FILE_COUNT_VIEW_RESP;

  export type Params = GetGroupFileCountParams;

  /** `busId=6` 是计数查询的固定值（写 0 会拿不到 count 块）。 */
  export const serialize = (p: Params): Record<string, unknown> => ({
    count: { groupUin: requireGroupId(p.groupId), appId: GROUP_FILE_APP_ID, busId: 6 },
  });

  export const deserialize = (body: Record<string, unknown>): GroupFileCount => {
    const block = (body.count ?? {}) as Record<string, unknown>;
    return {
      fileCount: toInt(block.fileCount),
      maxCount: toInt(block.maxCount) || 10000,
      isFull: block.isFull === true,
    };
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<GroupFileCount> =>
    invokeOidb(nt, pid, GetGroupFileCount as OidbSpec<Params, GroupFileCount>, params);
}

// ───────────────────────── 空间占用 — 0x6D8_3 ─────────────────────────

export interface GroupFileSpace {
  usedSpace: number;
  totalSpace: number;
}

export interface GetGroupFileSpaceParams {
  groupId: number;
}

export namespace GetGroupFileSpace {
  export const command = 0x6d8;
  export const subCommand = 3;
  export const reqSchema = OIDB_GROUP_FILE_SPACE_VIEW_REQ;
  export const respSchema = OIDB_GROUP_FILE_SPACE_VIEW_RESP;

  export type Params = GetGroupFileSpaceParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    space: { groupUin: requireGroupId(p.groupId), appId: GROUP_FILE_APP_ID },
  });

  export const deserialize = (body: Record<string, unknown>): GroupFileSpace => {
    const block = (body.space ?? {}) as Record<string, unknown>;
    return {
      usedSpace: toInt(block.usedSpace),
      totalSpace: toInt(block.totalSpace),
    };
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<GroupFileSpace> =>
    invokeOidb(nt, pid, GetGroupFileSpace as OidbSpec<Params, GroupFileSpace>, params);
}

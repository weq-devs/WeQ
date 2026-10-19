/**
 * GroupFileService — 群文件目录列表 (OIDB 0x6D8_1)。协议定义和分发在
 * @weq/protocol,这层只负责分页循环和 uploaderName 的群名片兜底。
 *
 * 下载直链走 MediaUrlService.getGroupFileUrl (0x6D6_2),不在这里重复。
 */
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import {
  CreateGroupFolder,
  DeleteGroupFile,
  DeleteGroupFolder,
  GetGroupFileCount,
  GetGroupFileSpace,
  ListGroupFiles,
  MoveGroupFile,
  RenameGroupFile,
  RenameGroupFolder,
  type CreatedGroupFolder,
  type GroupFileCount,
  type GroupFileItem,
  type GroupFileSpace,
  type GroupFolderItem,
} from '@weq/protocol';

export type { GroupFileItem, GroupFolderItem };

export interface GroupFileListing {
  targetDirectory: string;
  files: GroupFileItem[];
  folders: GroupFolderItem[];
}

const PAGE_SIZE = 100;
/** 分页上限 —— 兜底防止服务端不给 isEnd 导致死循环。 */
const MAX_PAGES = 200;

export class GroupFileService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket'>,
    _session: AccountSession,
    private readonly resolvePid: () => number,
  ) {}

  /** 拉某个目录下的全部文件+子文件夹(内部翻页到 isEnd)。 */
  async list(groupId: number, targetDirectory = '/'): Promise<GroupFileListing> {
    const dir = targetDirectory || '/';
    const files: GroupFileItem[] = [];
    const folders: GroupFolderItem[] = [];

    let startIndex = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await ListGroupFiles.invoke(this.nt, this.resolvePid(), {
        groupId,
        targetDirectory: dir,
        startIndex,
        pageSize: PAGE_SIZE,
      });
      files.push(...res.files);
      folders.push(...res.folders);
      if (res.isEnd || res.files.length + res.folders.length === 0) break;
      startIndex += PAGE_SIZE;
    }

    return { targetDirectory: dir, files, folders };
  }

  /** 递归拉全群文件,给每个文件带上相对根目录的路径段(用于导出建目录树)。 */
  async listRecursive(groupId: number): Promise<Array<GroupFileItem & { path: string[] }>> {
    const out: Array<GroupFileItem & { path: string[] }> = [];
    const queue: Array<{ dir: string; path: string[] }> = [{ dir: '/', path: [] }];
    const seen = new Set<string>(['/']);

    while (queue.length > 0) {
      const { dir, path } = queue.shift()!;
      const listing = await this.list(groupId, dir);
      for (const file of listing.files) out.push({ ...file, path });
      for (const folder of listing.folders) {
        if (!folder.folderId || seen.has(folder.folderId)) continue;
        seen.add(folder.folderId);
        queue.push({ dir: folder.folderId, path: [...path, folder.folderName || folder.folderId] });
      }
    }

    return out;
  }

  // ───────────────────────── 文件 / 文件夹写操作 ─────────────────────────

  /** 删除单个群文件（OIDB 0x6D6_3）。 */
  async deleteFile(groupId: number, fileId: string): Promise<void> {
    await DeleteGroupFile.invoke(this.nt, this.resolvePid(), { groupId, fileId });
  }

  /** 重命名群文件（OIDB 0x6D6_4）。 */
  async renameFile(
    groupId: number,
    fileId: string,
    parentDirectory: string,
    newFileName: string,
  ): Promise<void> {
    await RenameGroupFile.invoke(this.nt, this.resolvePid(), {
      groupId,
      fileId,
      parentDirectory: parentDirectory || '/',
      newFileName,
    });
  }

  /** 移动群文件到另一个目录（OIDB 0x6D6_5）。 */
  async moveFile(
    groupId: number,
    fileId: string,
    parentDirectory: string,
    targetDirectory: string,
  ): Promise<void> {
    await MoveGroupFile.invoke(this.nt, this.resolvePid(), {
      groupId,
      fileId,
      parentDirectory: parentDirectory || '/',
      targetDirectory: targetDirectory || '/',
    });
  }

  /** 新建文件夹（OIDB 0x6D7_0），返回新建的 folderId 等信息。 */
  async createFolder(
    groupId: number,
    parentId: string,
    folderName: string,
  ): Promise<CreatedGroupFolder> {
    return CreateGroupFolder.invoke(this.nt, this.resolvePid(), {
      groupId,
      parentId: parentId || '/',
      folderName,
    });
  }

  /** 删除文件夹（OIDB 0x6D7_1）。 */
  async deleteFolder(groupId: number, folderId: string): Promise<void> {
    await DeleteGroupFolder.invoke(this.nt, this.resolvePid(), { groupId, folderId });
  }

  /** 重命名文件夹（OIDB 0x6D7_2）。 */
  async renameFolder(groupId: number, folderId: string, newFolderName: string): Promise<void> {
    await RenameGroupFolder.invoke(this.nt, this.resolvePid(), {
      groupId,
      folderId,
      newFolderName,
    });
  }

  /** 群文件数量 / 上限（OIDB 0x6D8_2）。 */
  async count(groupId: number): Promise<GroupFileCount> {
    return GetGroupFileCount.invoke(this.nt, this.resolvePid(), { groupId });
  }

  /** 群文件空间占用（OIDB 0x6D8_3）。 */
  async space(groupId: number): Promise<GroupFileSpace> {
    return GetGroupFileSpace.invoke(this.nt, this.resolvePid(), { groupId });
  }
}

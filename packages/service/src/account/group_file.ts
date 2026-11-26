/**
 * GroupFileService — 群文件目录列表 (OIDB 0x6D8_1)。协议定义和分发在
 * @weqbot/protocol,这层只负责分页循环和 uploaderName 的群名片兜底。
 *
 * 下载直链走 MediaUrlService.getGroupFileUrl (0x6D6_2),不在这里重复。
 */
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { JsonStore } from '../common/json_store';
import {
  GROUP_PERMANENT_FILE_BUS_ID,
  groupPermission,
  isTemporaryGroupFile,
  qqResourceOwnedBy,
  type QQGroupOperation,
  type QQGroupPermissionContext,
} from '../common/qq_permissions';
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
  TransGroupFile,
  type CreatedGroupFolder,
  type GroupFileCount,
  type GroupFileItem,
  type GroupFileSpace,
  type GroupFolderItem,
} from '@weqbot/protocol';

export type { GroupFileItem, GroupFolderItem };

export interface GroupFileListing {
  targetDirectory: string;
  files: GroupFileItem[];
  folders: GroupFolderItem[];
}

const PAGE_SIZE = 100;
/** 分页上限 —— 兜底防止服务端不给 isEnd 导致死循环。 */
const MAX_PAGES = 200;
const MAX_PERMISSION_DIRECTORIES = 32;

export class GroupFileService {
  private readonly transferSources?: JsonStore<Record<string, unknown>>;

  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket'>,
    private readonly session: AccountSession,
    private readonly resolvePid: () => number,
    private readonly permissionContext?: (groupId: number) => Promise<QQGroupPermissionContext>,
    transferSourcesPath?: string,
  ) {
    if (transferSourcesPath)
      this.transferSources = new JsonStore<Record<string, unknown>>(
        transferSourcesPath,
        () => ({}),
        {
          normalize(raw) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw))
              throw new Error('群文件转存记录结构无效');
            return raw as Record<string, unknown>;
          },
        },
      );
  }

  originalFileId(groupCode: string, fileId: string): string | undefined {
    const source = this.transferSources?.data[`${groupCode}:${fileId}`];
    return typeof source === 'string' && source ? source : undefined;
  }

  private async permitted(
    action: QQGroupOperation,
    groupId: number,
    fileId?: string,
    directory?: string,
  ) {
    if (!this.permissionContext) return;
    const pid = this.resolvePid();
    const context = await this.permissionContext(groupId);
    if (
      !groupPermission(action, context) &&
      fileId &&
      (action === 'fileDelete' || action === 'fileRename')
    ) {
      const file = await this.permissionFile(groupId, fileId, directory);
      context.owned =
        file !== undefined &&
        qqResourceOwnedBy(file.uploaderUin, {
          uid: this.session.selfUid,
          uin: this.session.context.uin,
        });
    }
    if (!groupPermission(action, context)) throw new Error('当前账号无权执行此群文件操作');
    if (this.resolvePid() !== pid) throw new Error('QQ 运行时已改变，请重新操作');
  }

  private async permissionFile(
    groupId: number,
    fileId: string,
    directory?: string,
    check?: () => void,
  ): Promise<GroupFileItem | undefined> {
    const pending = [directory ?? '/'];
    const seen = new Set(pending);
    const pid = this.resolvePid();
    for (let count = 0; pending.length; count++) {
      if (count >= MAX_PERMISSION_DIRECTORIES)
        throw new Error('群文件目录较多，请提供文件所在的 parent_directory 后重试');
      const parent = pending.shift()!;
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) throw new Error('群文件分页超过上限，未找到目标文件');
        check?.();
        if (this.resolvePid() !== pid) throw new Error('QQ 运行时已改变，请重新操作');
        const listing = await this.listPage(groupId, parent, page * PAGE_SIZE, PAGE_SIZE);
        check?.();
        if (this.resolvePid() !== pid) throw new Error('QQ 运行时已改变，请重新操作');
        const file = listing.files.find((row) => row.fileId === fileId);
        if (file) return file;
        // OneBot 删除只要求 file_id；显式目录不扩成全群扫描。
        if (directory === undefined)
          for (const folder of listing.folders) {
            if (!folder.folderId || seen.has(folder.folderId)) continue;
            seen.add(folder.folderId);
            pending.push(folder.folderId);
          }
        if (listing.isEnd || listing.files.length + listing.folders.length === 0) break;
      }
    }
    return undefined;
  }

  findFileInDirectory(groupId: number, directory: string, fileId: string, check: () => void) {
    return this.permissionFile(groupId, fileId, directory, check);
  }

  async listPage(groupId: number, targetDirectory: string, startIndex: number, pageSize: number) {
    return ListGroupFiles.invoke(this.nt, this.resolvePid(), {
      groupId,
      targetDirectory,
      startIndex,
      pageSize,
    });
  }

  /** 拉某个目录下的全部文件+子文件夹(内部翻页到 isEnd)。 */
  async list(
    groupId: number,
    targetDirectory = '/',
    options: { beforeRequest?: () => void } = {},
  ): Promise<GroupFileListing> {
    const dir = targetDirectory || '/';
    const files: GroupFileItem[] = [];
    const folders: GroupFolderItem[] = [];

    let startIndex = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      options.beforeRequest?.();
      const res = await this.listPage(groupId, dir, startIndex, PAGE_SIZE);
      files.push(...res.files);
      folders.push(...res.folders);
      if (res.isEnd || res.files.length + res.folders.length === 0)
        return { targetDirectory: dir, files, folders };
      startIndex += PAGE_SIZE;
    }

    throw new Error('群文件分页超过上限，未返回截断列表');
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

  async makePermanent(
    groupId: number,
    fileId: string,
    directory: string,
    beforeRequest: () => void,
  ) {
    const pid = this.resolvePid();
    const check = () => {
      beforeRequest();
      if (this.resolvePid() !== pid) throw new Error('QQ 运行时已改变，请重新操作');
    };
    await this.permitted('manage', groupId);
    const listing = await this.list(groupId, directory, { beforeRequest: check });
    const matches = listing.files.filter((file) => file.fileId === fileId);
    const file = matches[0];
    if (matches.length !== 1 || !file || !isTemporaryGroupFile(file))
      throw new Error('该文件不是可确认的未过期临时群文件，请刷新目录');
    check();
    const result = await TransGroupFile.invoke(this.nt, pid, {
      groupId,
      fileId,
      busId: file.busId,
    });
    check();
    const savedId = result.saveFilePath || fileId;
    const folders = directory === '/' ? ['/'] : [directory, '/'];
    for (const folder of folders) {
      const refreshed = await this.list(groupId, folder, { beforeRequest: check }).catch(
        () => null,
      );
      check();
      const candidates = refreshed?.files.filter((item) => item.fileId === savedId) ?? [];
      if (candidates.length > 1) break;
      const saved = candidates[0];
      if (!saved) continue;
      // 聊天附件仍保留临时文件 ID，定位时需要同时识别两个 ID。
      if (this.transferSources && saved.fileId !== fileId) {
        this.transferSources.data[`${groupId}:${saved.fileId}`] = fileId;
        this.transferSources.save();
      }
      // 104 转存的回执可能仍带 104。目录的永久状态与新旧 ID 映射独立。
      const permanent =
        saved.busId === GROUP_PERMANENT_FILE_BUS_ID &&
        saved.expireTimeKnown === true &&
        saved.expireTime === 0;
      return {
        state: permanent ? ('accepted' as const) : ('unconfirmed' as const),
        fileId: saved.fileId,
        directory: folder,
      };
    }
    return { state: 'unconfirmed' as const, fileId: null, directory: null };
  }

  /** 删除单个群文件（OIDB 0x6D6_3）。 */
  async deleteFile(
    groupId: number,
    fileId: string,
    directory?: string,
    beforeSend?: () => void,
  ): Promise<void> {
    await this.permitted('fileDelete', groupId, fileId, directory);
    beforeSend?.();
    await DeleteGroupFile.invoke(this.nt, this.resolvePid(), { groupId, fileId });
  }

  /** 重命名群文件（OIDB 0x6D6_4）。 */
  async renameFile(
    groupId: number,
    fileId: string,
    parentDirectory: string,
    newFileName: string,
    beforeSend?: () => void,
  ): Promise<void> {
    await this.permitted('fileRename', groupId, fileId, parentDirectory);
    beforeSend?.();
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
    await this.permitted('fileMove', groupId);
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
    await this.permitted('folder', groupId);
    return CreateGroupFolder.invoke(this.nt, this.resolvePid(), {
      groupId,
      parentId: parentId || '/',
      folderName,
    });
  }

  /** 删除文件夹（OIDB 0x6D7_1）。 */
  async deleteFolder(groupId: number, folderId: string): Promise<void> {
    await this.permitted('folder', groupId);
    await DeleteGroupFolder.invoke(this.nt, this.resolvePid(), { groupId, folderId });
  }

  /** 重命名文件夹（OIDB 0x6D7_2）。 */
  async renameFolder(groupId: number, folderId: string, newFolderName: string): Promise<void> {
    await this.permitted('folder', groupId);
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

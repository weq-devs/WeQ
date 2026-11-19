/**
 * 闪传文件服务 —— 组合 HTTP2RPC 客户端 + 下载任务管理器，供 IPC 路由调用。
 *
 * 注意：与 account/flash_transfer.ts 的 FlashTransferService（OIDB 分享链接）
 * 是两回事，本服务只管浏览 / 下载，全程匿名 HTTP，不需要 QQ 在线。
 */
import { FlashTransferClient } from './client';
import { FlashTransferDownloadManager } from './manager';
import type { FlashListResult } from './types';
import { resolve } from 'node:path';

const managers = new Map<string, WeakRef<FlashTransferDownloadManager>>();

export class FlashTransferFilesService {
  readonly client: FlashTransferClient;
  readonly downloads: FlashTransferDownloadManager;

  constructor(baseDir: string) {
    this.client = new FlashTransferClient();
    const key = resolve(baseDir);
    for (const [path, manager] of managers) if (!manager.deref()) managers.delete(path);
    const existing = managers.get(key)?.deref();
    this.downloads = existing ?? new FlashTransferDownloadManager(key, this.client);
    if (!existing) managers.set(key, new WeakRef(this.downloads));
  }

  /** 拉一个目录（普通或压缩包内部）的完整列表。 */
  async listFiles(filesetId: string, parentId: string, zipFileId = ''): Promise<FlashListResult> {
    const isZip = zipFileId.length > 0;
    const files = isZip
      ? await this.client.listCompressedFiles(filesetId, zipFileId, parentId)
      : await this.client.listFiles(filesetId, parentId);
    return { filesetId, isZip, files };
  }
}

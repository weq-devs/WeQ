/**
 * FileAssistantService — manage file information from file_assistant.db.
 */

import type { AccountSession } from '@weq/account';
import { databaseRequestSignal, type FileAssistantRow } from '@weq/db';

export class FileAssistantService {
  private readonly pendingByMsgId = new Map<bigint, Promise<FileAssistantRow | null>>();

  constructor(private readonly session: AccountSession) {}

  /**
   * List all files from both tables, newest first.
   */
  async listAllFiles(limit = 100, offset = 0): Promise<FileAssistantRow[]> {
    return this.session.fileAssistant.listAll(limit, offset);
  }

  /**
   * Search file info by its msgId.
   */
  async getFileInfoByMsgId(msgId: bigint): Promise<FileAssistantRow | null> {
    // 可取消的调用各自保留数据库生命周期，避免一次取消影响其他请求。
    if (databaseRequestSignal()) return this.session.fileAssistant.getByMsgId(msgId);
    const pending = this.pendingByMsgId.get(msgId);
    if (pending) return pending;
    const lookup = this.session.fileAssistant.getByMsgId(msgId).finally(() => {
      this.pendingByMsgId.delete(msgId);
    });
    this.pendingByMsgId.set(msgId, lookup);
    return lookup;
  }
}

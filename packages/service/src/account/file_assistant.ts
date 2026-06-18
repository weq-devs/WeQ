/**
 * FileAssistantService — manage file information from file_assistant.db.
 */

import type { AccountSession } from '@weq/account';
import type { FileAssistantRow } from '@weq/db';

export class FileAssistantService {
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
    return this.session.fileAssistant.getByMsgId(msgId);
  }
}

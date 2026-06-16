/**
 * MsgSearchService — keyword search over an account's message history.
 *
 * Thin pass-through to `session.buddyMsgFts.search`, mirroring the
 * AccountSession → Db → (FTS) pipeline used by the other account services.
 * The underlying `buddy_msg_fts` table is QQ's own full-text-search index, so
 * results come back ranked best-match-first — no scoring done here.
 *
 * Returns the structured `BuddyMsgFtsHit[]`: `msgId` stays `bigint` to keep
 * 64-bit precision (the caller stringifies it at the IPC/JSON boundary, the
 * same way TestMsgService does); `content` is the matched message text.
 */

import type { AccountSession } from '@weq/account';
import type { BuddyMsgFtsHit } from '@weq/db';

export class MsgSearchService {
  constructor(private readonly session: AccountSession) {}

  /**
   * Find friend messages whose text or filename matches `keyword`.
   */
  searchBuddy(keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    return this.session.buddyMsgFts.search(keyword, limit);
  }

  /**
   * Find group messages whose text or filename matches `keyword`.
   */
  searchGroup(keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    return this.session.groupMsgFts.search(keyword, limit);
  }

  /**
   * Search within a specific friend conversation.
   */
  searchInBuddyConversation(targetUid: string, keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    return this.session.buddyMsgFts.searchInConversation(targetUid, keyword, limit);
  }

  /**
   * Search within a specific group conversation.
   */
  searchInGroupConversation(groupCode: string, keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    return this.session.groupMsgFts.searchInGroup(groupCode, keyword, limit);
  }

  /**
   * Search across both buddy and group message files.
   */
  async searchFiles(keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    const [buddyFiles, groupFiles] = await Promise.all([
      this.session.buddyMsgFts.searchFiles(keyword, limit),
      this.session.groupMsgFts.searchFiles(keyword, limit),
    ]);

    // Merge and re-sort by sendTime desc, then trim to limit
    return [...buddyFiles, ...groupFiles]
      .sort((a, b) => Number(b.sendTime - a.sendTime))
      .slice(0, limit);
  }

  /** @deprecated Use searchBuddy or searchGroup instead. */
  search(keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    return this.searchBuddy(keyword, limit);
  }
}

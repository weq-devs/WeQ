/**
 * MsgSearchService — keyword search over an account's message history.
 *
 * Shares the account's QQ FTS readers with unified search. The database
 * accessors retain their candidate limits and relevance ranking.
 *
 * Returns the structured `BuddyMsgFtsHit[]`: `msgId` stays `bigint` to keep
 * 64-bit precision (the caller stringifies it at the IPC/JSON boundary);
 * `content` is the matched message text.
 */

import type { AccountSession } from '@weq/account';
import {
  type BuddyMsgFtsHit,
  type C2cPartition,
  withDatabaseSignal,
  withDatabaseWorkload,
} from '@weq/db';
import type { UnifiedSearchService } from './unified_search';

function searchWithSignal<T>(signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
  return withDatabaseWorkload('bulk', () => (signal ? withDatabaseSignal(signal, read) : read()));
}

export class MsgSearchService {
  constructor(
    private readonly session: AccountSession,
    private readonly indexes?: Pick<UnifiedSearchService, 'messageIndex'>,
  ) {}

  /**
   * Find friend messages whose text or filename matches `keyword`.
   */
  searchBuddy(keyword: string, limit = 20, signal?: AbortSignal): Promise<BuddyMsgFtsHit[]> {
    return searchWithSignal(signal, () =>
      this.session.buddyMsgFts.search(keyword, limit, this.indexes?.messageIndex('buddy')),
    );
  }

  /**
   * Find group messages whose text or filename matches `keyword`.
   */
  searchGroup(keyword: string, limit = 20, signal?: AbortSignal): Promise<BuddyMsgFtsHit[]> {
    return searchWithSignal(signal, () =>
      this.session.groupMsgFts.search(keyword, limit, this.indexes?.messageIndex('group')),
    );
  }

  /**
   * Search within a specific friend conversation. Resolves the peer uid to its
   * indexed sort number (column 40027) via the session's resident `UidMap` so
   * the query hits the FTS conversation index; a missing mapping falls back to
   * an unindexed uid (40021) scan.
   */
  searchInBuddyConversation(
    targetUid: string,
    keyword: string,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<BuddyMsgFtsHit[]> {
    return searchWithSignal(signal, () =>
      this.session.buddyMsgFts.searchInConversation(
        this.c2cPartition(targetUid),
        keyword,
        limit,
        this.indexes?.messageIndex('buddy'),
      ),
    );
  }

  /** Resolve a peer uid to its indexed partition (sortNo), else fall back to uid. */
  private c2cPartition(targetUid: string): C2cPartition {
    const sortNo = this.session.uidMap.sortNoByUid(targetUid);
    return sortNo !== undefined ? { sortNo } : { uid: targetUid };
  }

  /**
   * Search within a specific group conversation.
   */
  searchInGroupConversation(
    groupCode: string,
    keyword: string,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<BuddyMsgFtsHit[]> {
    return searchWithSignal(signal, () =>
      this.session.groupMsgFts.searchInGroup(
        groupCode,
        keyword,
        limit,
        this.indexes?.messageIndex('group'),
      ),
    );
  }

  /**
   * Search across both buddy and group message files.
   */
  async searchFiles(keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    const [buddyFiles, groupFiles] = await Promise.all([
      this.session.buddyMsgFts.searchFiles(keyword, limit, this.indexes?.messageIndex('buddy')),
      this.session.groupMsgFts.searchFiles(keyword, limit, this.indexes?.messageIndex('group')),
    ]);

    // Merge and re-sort by sendTime desc, then trim to limit
    return [...buddyFiles, ...groupFiles]
      .sort((a, b) => Number(b.sendTime - a.sendTime))
      .slice(0, limit);
  }
}

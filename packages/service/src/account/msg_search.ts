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
   * Find messages whose text matches `keyword`, highest relevance first.
   * Defaults to the top 20 hits. A blank keyword returns an empty array.
   */
  search(keyword: string, limit = 20): Promise<BuddyMsgFtsHit[]> {
    return this.session.buddyMsgFts.search(keyword, limit);
  }
}

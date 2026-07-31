/**
 * RecentContactService — the recent-conversations list for one account.
 *
 * Thin pass-through over `session.recentContacts.getRecentContact`, mirroring
 * the AccountSession → Db → codec pipeline. Returns the structured
 * `RecentContact[]` (newest first); bigint timestamps are handled at the
 * IPC/JSON boundary by the caller.
 */

import type { AccountSession } from '@weq/account';
import type { RecentContact, RecentContactTop } from '@weq/db';

export class RecentContactService {
  constructor(private readonly session: AccountSession) {}

  /** Recent conversations, newest first. Defaults to 200. */
  getRecentContact(limit = 200): Promise<RecentContact[]> {
    return this.session.recentContacts.getRecentContact(limit);
  }

  /** 置顶会话，最近置顶的在前。 */
  getTopContacts(): Promise<RecentContactTop[]> {
    return this.session.recentContactTops.getTopContacts();
  }
}

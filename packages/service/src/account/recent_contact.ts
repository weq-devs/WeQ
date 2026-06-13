/**
 * RecentContactService — the recent-conversations list for one account.
 *
 * Thin pass-through over `session.recentContacts.getRecentContact`, mirroring
 * the AccountSession → Db → codec pipeline used by TestMsgService. Returns the
 * structured `RecentContact[]` (newest first); bigint timestamps are handled at
 * the IPC/JSON boundary by the caller, the same way TestMsgService does.
 */

import type { AccountSession } from '@weq/account';
import type { RecentContact } from '@weq/db';

export class RecentContactService {
  constructor(private readonly session: AccountSession) {}

  /** Recent conversations, newest first. Defaults to 200. */
  getRecentContact(limit = 200): Promise<RecentContact[]> {
    return this.session.recentContacts.getRecentContact(limit);
  }
}

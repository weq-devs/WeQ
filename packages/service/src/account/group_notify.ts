/**
 * GroupNotifyService — list group notifications from both normal and doubt tables.
 */

import type { AccountSession } from '@weq/account';
import type { GroupNotify } from '@weq/db';

export class GroupNotifyService {
  constructor(private readonly session: AccountSession) {}

  /**
   * List all group notifications from both tables, newest first.
   */
  async listAllNotifications(limit = 100, offset = 0): Promise<GroupNotify[]> {
    const [normal, doubt] = await Promise.all([
      this.session.groupNotifies.listNormal(limit + offset, 0),
      this.session.groupNotifies.listDoubt(limit + offset, 0),
    ]);

    const all = [...normal, ...doubt];
    // Sort by msgTime descending (newest first)
    all.sort((a, b) => b.msgTime - a.msgTime);

    return all.slice(offset, offset + limit);
  }

  /**
   * List only normal group notifications.
   */
  async listNormalNotifications(limit = 100, offset = 0): Promise<GroupNotify[]> {
    return this.session.groupNotifies.listNormal(limit, offset);
  }

  /**
   * List only "doubt" (filtered/suspicious) group notifications.
   */
  async listDoubtNotifications(limit = 100, offset = 0): Promise<GroupNotify[]> {
    return this.session.groupNotifies.listDoubt(limit, offset);
  }
}

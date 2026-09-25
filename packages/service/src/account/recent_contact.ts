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
  getRecentContact(
    limit = 200,
    offset = 0,
    opts: { excludeChatTypes?: readonly number[] } = {},
  ): Promise<RecentContact[]> {
    return this.session.recentContacts.getRecentContact(limit, offset, opts);
  }

  /** Total count matching {@link getRecentContact} (same exclusion rules). */
  countRecentContact(opts: { excludeChatTypes?: readonly number[] } = {}): Promise<number> {
    return this.session.recentContacts.countRecentContact(opts);
  }

  /** 置顶会话，最近置顶的在前。 */
  getTopContacts(): Promise<RecentContactTop[]> {
    return this.session.recentContactTops.getTopContacts();
  }

  /**
   * 有草稿的会话 → 草稿时间（targetUid -> unix 秒）。读的是
   * `recent_contact_v3_table."41108"`（草稿表 `40050` 的跨表镜像），只返回
   * `41108 > 0` 的行。前端拿它和最后消息时间取最大值给会话排序。
   */
  listDraftTimes(): Promise<Map<string, bigint>> {
    return this.session.recentContacts.listDraftTimes();
  }
}

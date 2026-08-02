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

    return this.withUins(all.slice(offset, offset + limit));
  }

  /**
   * List only normal group notifications.
   */
  async listNormalNotifications(limit = 100, offset = 0): Promise<GroupNotify[]> {
    return this.withUins(await this.session.groupNotifies.listNormal(limit, offset));
  }

  /**
   * List only "doubt" (filtered/suspicious) group notifications.
   */
  async listDoubtNotifications(limit = 100, offset = 0): Promise<GroupNotify[]> {
    return this.withUins(await this.session.groupNotifies.listDoubt(limit, offset));
  }

  /**
   * group_notify_list 只存 uid，没有 uin —— 而头像 CDN 按 uin 取。一次批量查
   * profile_info_v6 把申请人 / 处理人的 uin 补上，否则前端只能画默认头像。
   * 查不到的 uid 留空（调用方降级到 uid 展示）。
   */
  private async withUins(notifies: GroupNotify[]): Promise<GroupNotify[]> {
    const uids = new Set<string>();
    for (const n of notifies) {
      if (n.operatedUser?.uid) uids.add(n.operatedUser.uid);
      if (n.operatorUser?.uid) uids.add(n.operatorUser.uid);
    }
    if (uids.size === 0) return notifies;

    let uinByUid = new Map<string, string>();
    try {
      const profiles = await this.session.profileInfo.profilesByUids([...uids]);
      uinByUid = new Map(
        profiles.filter((p) => p.uin > 0n).map((p) => [p.uid, p.uin.toString()] as const),
      );
    } catch {
      return notifies;
    }

    for (const n of notifies) {
      if (n.operatedUser) n.operatedUser.uin = uinByUid.get(n.operatedUser.uid) ?? '';
      if (n.operatorUser) n.operatorUser.uin = uinByUid.get(n.operatorUser.uid) ?? '';
    }
    return notifies;
  }
}

/**
 * GroupNotifyService — list group notifications from both normal and doubt tables.
 */

import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import type { GroupNotify } from '@weq/db';
import {
  FetchFilteredGroupRequests,
  FetchGroupRequests,
  SetGroupRequest,
  groupRequestOperationType,
  type GroupRequest,
  type GroupRequestPage,
} from '@weq/protocol';

/** 在线处理加群请求需要的最小原生面。 */
export interface GroupNotifyOnlineDeps {
  nt: Pick<NtHelperBinding, 'sendOidbPacket'>;
  resolvePid: () => number;
}

const GROUP_REQUEST_PAGE_SIZE = 50;
/** 拉取时翻页上限，防止服务端不给空 cookie 导致死循环。 */
const GROUP_REQUEST_MAX_PAGES = 20;

export class GroupNotifyService {
  constructor(
    private readonly session: AccountSession,
    private readonly online?: GroupNotifyOnlineDeps,
  ) {}

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

  // ───────────────────────── 在线拉取 / 处理加群请求 ─────────────────────────

  /**
   * 从 0x10C0 拉取加群请求（主 / 过滤收件箱）。
   *
   * 与本地 `group_notify_list` 的区别：这里拿到的是服务端**当前待处理**的请求，
   * 带 `sequence` / `eventType` / `operateTransInfo`，处理时原样回传。
   * 高频调用会风控，调用方自行限流。
   */
  async fetchOnlineRequests(
    options: { filtered?: boolean; maxPages?: number } = {},
  ): Promise<GroupRequest[]> {
    if (!this.online) throw new Error('该账号当前不在线，无法拉取加群请求。');
    const { nt, resolvePid } = this.online;
    const out: GroupRequest[] = [];
    let cookie: number | bigint = 0;
    const maxPages = options.maxPages ?? GROUP_REQUEST_MAX_PAGES;
    for (let page = 0; page < maxPages; page += 1) {
      const result: GroupRequestPage = options.filtered
        ? await FetchFilteredGroupRequests.invoke(nt, resolvePid(), {
            count: GROUP_REQUEST_PAGE_SIZE,
            cookie,
          })
        : await FetchGroupRequests.invoke(nt, resolvePid(), {
            count: GROUP_REQUEST_PAGE_SIZE,
            cookie,
          });
      out.push(...result.requests);
      if (result.cookie === 0 || result.requests.length < GROUP_REQUEST_PAGE_SIZE) break;
      cookie = result.cookie;
    }
    return out;
  }

  async handleOnlineRequest(
    request: Pick<
      GroupRequest,
      'groupId' | 'sequence' | 'eventType' | 'filtered' | 'operateTransInfo'
    >,
    approve: boolean,
    reason = '',
  ): Promise<void> {
    if (!this.online) throw new Error('该账号当前不在线，无法处理加群请求。');
    const { nt, resolvePid } = this.online;
    const eventType = groupRequestOperationType(request.eventType) ?? request.eventType;
    await SetGroupRequest.invoke(nt, resolvePid(), {
      groupId: request.groupId,
      sequence: request.sequence,
      eventType,
      approve,
      reason,
      filtered: request.filtered,
      ...(request.operateTransInfo ? { operateTransInfo: request.operateTransInfo } : {}),
    });
  }
}

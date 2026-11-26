/**
 * GroupNotifyService — list group notifications from both normal and doubt tables.
 */

import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import type { GroupNotify } from '@weq/db';
import {
  FetchFilteredGroupRequests,
  FetchGroupRequests,
  ReportGroupNoticeRead,
  SetGroupRequest,
  groupRequestOperationType,
  type GroupRequest,
  type GroupRequestPage,
} from '@weqbot/protocol';
import { getLogger } from '../common/logger';
import { OperationError } from '../common/operation_error';

/** 在线处理加群请求需要的最小原生面。 */
export interface GroupNotifyOnlineDeps {
  nt: Pick<NtHelperBinding, 'sendOidbPacket'>;
  resolvePid: () => number;
}

const GROUP_REQUEST_PAGE_SIZE = 50;
/** 拉取时翻页上限，防止服务端不给空 cookie 导致死循环。 */
const GROUP_REQUEST_MAX_PAGES = 20;
const logger = getLogger().child({ scope: 'group-notice' });
/** 应用只在后续有实际需求时再读；这段时间用于合并失败后的触发。 */
const GROUP_NOTICE_RATE_LIMIT_PAUSE_MS = 60_000;
const rateLimited =
  /(?:操作|请求|访问)(?:过于|太|过)?频繁|频率(?:超限|限制)|too many requests|\brate limit(?:ed| exceeded)?\b/i;
const accountRestricted =
  /(?:账号|帐号)(?:已|被|暂时)*(?:封禁|冻结|受限|限制)|account (?:is )?(?:restricted|suspended|frozen)/i;
type GroupNoticeOperation =
  | 'normal-list'
  | 'filtered-list'
  | 'read-report'
  | 'normal-approval'
  | 'filtered-approval';

type GroupInbox = Omit<GroupRequestPage, 'cookie' | 'rawCookie'> & { nextCursor?: bigint };

export class GroupNotifyService {
  private readReports: Promise<unknown> = Promise.resolve();
  private readonly inboxPages = new Map<string, Promise<GroupRequestPage>>();
  private readonly rateLimits = new Map<
    GroupNoticeOperation,
    { until: number; error: OperationError }
  >();
  private accountRestriction?: OperationError;

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
   * 页面按需查询；同一 QQ 运行时的相同分页合并在途读取。
   */
  async fetchOnlineRequests(
    options: { filtered?: boolean; maxPages?: number } = {},
  ): Promise<GroupRequest[]> {
    return (await this.fetchOnlineInbox(options)).requests;
  }

  async fetchOnlineInbox(
    options: { filtered?: boolean; maxPages?: number; cursor?: bigint; manual?: boolean } = {},
  ): Promise<GroupInbox> {
    if (!this.online) throw new Error('该账号当前不在线，无法拉取加群请求。');
    const pid = this.online.resolvePid();
    const out: GroupRequest[] = [];
    let cookie = options.cursor ?? 0n;
    let firstPage: GroupRequestPage | undefined;
    const seen = new Set<bigint>();
    const maxPages = options.maxPages ?? GROUP_REQUEST_MAX_PAGES;
    for (let page = 0; page < maxPages; page += 1) {
      seen.add(cookie);
      const result = await this.fetchInboxPage(
        pid,
        Boolean(options.filtered),
        cookie,
        page === 0 && options.manual === true,
      );
      out.push(...result.requests);
      firstPage ??= result;
      cookie = result.rawCookie ?? BigInt(result.cookie);
      if (cookie <= 0n || seen.has(cookie) || result.requests.length < GROUP_REQUEST_PAGE_SIZE) {
        cookie = 0n;
        break;
      }
    }
    return {
      requests: out,
      latestSequence: firstPage?.latestSequence,
      readSequence: firstPage?.readSequence,
      nextCursor: cookie || undefined,
    };
  }

  private async fetchInboxPage(
    pid: number,
    filtered: boolean,
    cookie: bigint,
    manual: boolean,
  ): Promise<GroupRequestPage> {
    const { nt, resolvePid } = this.online!;
    if (resolvePid() !== pid) throw new Error('QQ 运行时已切换，请重新打开群通知。');
    const operation = filtered ? 'filtered-list' : 'normal-list';
    const accountRestriction = this.accountRestriction;
    this.assertOnlineOperation(operation, manual && !filtered && cookie === 0n);
    const key = `${pid}:${filtered}:${cookie}`;
    const inflight = this.inboxPages.get(key);
    if (inflight) return inflight;
    const task = (async () => {
      logger.debug('读取 QQ 群通知', {
        event: 'group-notice-fetch',
        filtered,
        firstPage: cookie === 0n,
      });
      const request = filtered ? FetchFilteredGroupRequests : FetchGroupRequests;
      try {
        const page = await request.invoke(nt, pid, { count: GROUP_REQUEST_PAGE_SIZE, cookie });
        if (resolvePid() !== pid) throw new Error('QQ 运行时已切换，请重新打开群通知。');
        if (accountRestriction && this.accountRestriction === accountRestriction)
          this.accountRestriction = undefined;
        return page;
      } catch (error) {
        throw this.onOnlineError(operation, error);
      }
    })().finally(() => this.inboxPages.delete(key));
    this.inboxPages.set(key, task);
    return task;
  }

  private assertOnlineOperation(operation: GroupNoticeOperation, verifyAccount = false) {
    if (this.accountRestriction && !verifyAccount) throw this.accountRestriction;
    const limit = this.rateLimits.get(operation);
    if (!limit) return;
    if (Date.now() < limit.until) throw limit.error;
    this.rateLimits.delete(operation);
  }

  private onOnlineError(operation: GroupNoticeOperation, error: unknown): unknown {
    if (!(error instanceof Error)) return error;
    if (accountRestricted.test(error.message)) {
      this.accountRestriction = new OperationError(
        'QQ 提示账号受限。请在 QQ 确认可用后，再手动刷新群通知。',
        'expected',
        { cause: error },
      );
      logger.warn('QQ 群通知因账号限制暂停', { event: 'group-notice-restricted', operation });
      return this.accountRestriction;
    }
    if (!rateLimited.test(error.message)) return error;
    const failure = new OperationError('QQ 提示该操作过于频繁，请稍后再试。', 'expected', {
      cause: error,
    });
    this.rateLimits.set(operation, {
      until: Date.now() + GROUP_NOTICE_RATE_LIMIT_PAUSE_MS,
      error: failure,
    });
    logger.warn('QQ 群通知操作暂时限流', { event: 'group-notice-rate-limited', operation });
    return failure;
  }

  /** 每次仅提交界面提供的序号。较晚到达的通知仍由 QQ 保留为未读。 */
  reportNoticeRead(sequence: bigint, assertCurrent: () => void): Promise<bigint | undefined> {
    const report = this.readReports.then(async () => {
      if (!this.online) return undefined;
      assertCurrent();
      this.assertOnlineOperation('read-report');
      const { nt, resolvePid } = this.online;
      const pid = resolvePid();
      const before = await this.fetchOnlineInbox({ maxPages: 1 });
      assertCurrent();
      this.assertOnlineOperation('read-report');
      if (resolvePid() !== pid) return undefined;
      if (before.readSequence === undefined || before.latestSequence === undefined)
        return before.readSequence;
      if (sequence <= before.readSequence || sequence > before.latestSequence)
        return before.readSequence;
      // SDK 报错时也尝试独立读回，避免下一次阅读重复上报已经生效的结果。
      try {
        await ReportGroupNoticeRead.invoke(nt, pid, sequence);
      } catch (error) {
        const failure = this.onOnlineError('read-report', error);
        if (failure !== error) throw failure;
        assertCurrent();
        const after = await this.fetchOnlineInbox({ maxPages: 1 });
        assertCurrent();
        if (after.readSequence !== undefined && after.readSequence >= sequence)
          return after.readSequence;
        throw failure;
      }
      assertCurrent();
      const after = await this.fetchOnlineInbox({ maxPages: 1 });
      assertCurrent();
      return after.readSequence;
    });
    this.readReports = report.catch(() => undefined);
    return report;
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
    const operation = request.filtered ? 'filtered-approval' : 'normal-approval';
    this.assertOnlineOperation(operation);
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
    }).catch((error: unknown) => {
      throw this.onOnlineError(operation, error);
    });
  }
}

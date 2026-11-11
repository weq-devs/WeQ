import { join } from 'node:path';
import {
  ContactMetricsService,
  ContactHistoryService,
  installContactHistoryCapture,
  ContactMetricsOfflineError,
  DirectoryTimeReader,
  type ContactMetric,
  type ContactMetricRows,
  type ContactMetricJob,
  type ContactMetricsProgress,
  type DbWatchService,
} from '@weq/service';
import { databaseRequestSignal, withDatabasePriority, withDatabaseSignal } from '@weq/db';
import type { AccountSession } from '@weq/account';
import { classifyChatType } from '@weq/codec';
import type { AccountServices } from './app_context';
import { backgroundTasks } from '../background_tasks';
const validContactUid = (uid: string) => /^u_[A-Za-z0-9_-]+$/.test(uid);
type RefreshContact = { uid: string; uin: bigint };

const METRIC_NAMES: Record<ContactMetric, string> = {
  level: 'QQ 等级',
  likeCount: '获赞数',
  addedAt: '添加时间',
  direction: '添加方向',
  commonFriends: '共同好友数',
  commonGroups: '共同群聊',
  friendCount: '群内好友数',
  activityScore: '群活跃度',
  energy: 'QQ 能量值',
  source: '添加来源',
  sourceGroup: '来源群',
  schools: '学校',
  joinedAt: '我的入群时间',
  grade: 'grade',
  freezeState: '冻结状态',
};
function needsMetricRefresh(
  cell: ContactMetricRows[string][ContactMetric],
  force: boolean,
  maxAgeMs?: number,
) {
  if (force || !cell) return true;
  return maxAgeMs === undefined
    ? cell.state === 'stale'
    : !cell.updatedAt || Date.now() - cell.updatedAt > maxAgeMs;
}
function formatMetrics(row: ContactMetricRows[string]) {
  return Object.fromEntries(
    Object.entries(row).map(([key, cell]) => [
      METRIC_NAMES[key as ContactMetric],
      {
        值:
          key === 'addedAt' && typeof cell.value === 'number'
            ? new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai',
                dateStyle: 'medium',
                timeStyle: 'medium',
              }).format(cell.value * 1000)
            : key === 'direction'
              ? cell.value === 'incoming'
                ? '对方添加我'
                : cell.value === 'outgoing'
                  ? '我添加对方'
                  : '未知'
              : (cell.value ?? '未知'),
        状态:
          cell.state === 'ready'
            ? '获取成功'
            : cell.state === 'failed'
              ? '读取失败，保留已有值'
              : '待更新',
        错误: cell.error,
      },
    ]),
  );
}

/** 桌面与 Web 共用的账号级编排，任务记录不拥有缓存文件。 */
export class ContactDirectoryRuntime {
  readonly cache: ContactMetricsService;
  readonly history: ContactHistoryService;
  private readonly stopHistoryCapture: () => void;
  taskId?: string;
  private target: 'metrics' | 'groupMembers' = 'metrics';
  private relationGraphRevision = 0;
  private preparing = false;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private readonly memberObserver: NonNullable<
    AccountServices['groupInfo']['contactMembersObserved']
  >;
  private watches: Array<{ unmount(): void }> = [];
  private timer?: ReturnType<typeof setTimeout>;
  private checking = false;
  private checkAgain = false;
  private roster = new Map<string, string>();
  private memberships = new Map<string, Set<string>>();
  private groupCodes = new Set<string>();
  private groupBaselineReady = false;
  private profileSignature = '';
  private pendingKinds = new Set<'profile' | 'group'>();
  private stopPreparing = false;
  private logs: Array<{
    ts: number;
    seq: number;
    stage: string;
    level: 'info' | 'error';
    text: string;
  }> = [];
  private logSequence = 0;
  private summaries = new Map<string, string>();
  private friendMeta = new Map<string, Record<string, unknown>>();
  private groupMeta = new Map<string, Record<string, unknown>>();
  private scope: { uin: string; configId: string };
  private readonly selfUid: string;
  private readonly timeReaders: Record<'friends' | 'groups', DirectoryTimeReader>;
  private readonly stopProfileWatch?: () => void;

  constructor(
    private readonly services: AccountServices,
    private readonly session: AccountSession,
    cacheDir: string,
    watcher: DbWatchService,
    private readonly online: () => boolean,
    private readonly current: () => boolean,
    configId: string,
    private readonly watchDelay = 2000,
  ) {
    this.scope = { uin: session.context.uin, configId };
    this.selfUid = session.selfUid;
    this.timeReaders = {
      friends: new DirectoryTimeReader(
        (cursor) => session.c2cMsgs.directoryTimePage(cursor),
        this.selfUid,
        session.context.uin,
      ),
      groups: new DirectoryTimeReader(
        (cursor) => session.groupMsgs.directoryTimePage(cursor),
        this.selfUid,
        session.context.uin,
      ),
    };
    services.groupInfo.setMemberRosterCache(join(cacheDir, 'group-members'));
    services.groupInfo.setGroupProfileCache(join(cacheDir, 'group-profiles'));
    this.history = new ContactHistoryService(cacheDir);
    services.groupInfo.setContactHistory?.(this.history);
    this.stopHistoryCapture = installContactHistoryCapture(
      services,
      this.history,
      session.context.uin,
      () => this.isCurrent(),
      () => this.online(),
    );
    this.cache = new ContactMetricsService(
      join(cacheDir, 'metrics.json'),
      () => this.online() && this.current(),
      { interval: 500, concurrency: 2 },
      this.history,
    );
    services.accountWrite.contactMetrics = this.cache;
    services.peerStats.contactMetrics = this.cache;
    if (services.profileExtras) services.profileExtras.contactMetrics = this.cache;
    services.groupInfo.contactMetrics = this.cache;
    this.memberObserver = (groupId, members) =>
      withDatabaseSignal(this.lifetime.signal, async () => {
        if (!this.isCurrent()) return;
        if (members.some((member) => !validContactUid(member.uid))) return;
        try {
          const buddies = new Set((await this.friends()).map((friend) => friend.uid));
          this.assertCurrent();
          const ids = new Set(
            members.map((member) => member.uid).filter((uid) => buddies.has(uid)),
          );
          await this.cache.record(`group:${groupId}`, { friendCount: ids.size });
          const self = members.find(
            (member) =>
              (Boolean(this.selfUid) && member.uid === this.selfUid) ||
              (!member.uid && String(member.uin) === this.scope.uin),
          );
          if (self?.joinTime && self.joinTime > 0)
            await this.cache.record(`group:${groupId}`, { joinedAt: self.joinTime });
          this.assertCurrent();
          this.memberships.set(String(groupId), ids);
        } catch (error) {
          if (this.isCurrent() && !databaseRequestSignal()?.aborted) throw error;
        }
      });
    services.groupInfo.contactMembersObserved = this.memberObserver;
    this.cache.on('progress', (progress: ContactMetricsProgress) => this.updateTask(progress));
    this.cache.on('log', (message: string, stage?: string) => this.appendLog(message, stage));
    this.stopProfileWatch = services.intentSense?.onCachedProfilesChanged?.(() => {
      if (this.isCurrent()) this.cache.emit('profilesChanged');
    });
    if (session.c2cMsgs?.sourcePath)
      this.watches.push(
        watcher.mount({
          dbPath: session.c2cMsgs.sourcePath,
          onDbFileChangeHook: () => {
            this.timeReaders.friends.invalidate();
            this.timeReaders.groups.invalidate();
          },
        }),
      );
    for (const dbPath of new Set([session.profileInfo.dbPath, session.groupMembers.dbPath])) {
      this.watches.push(
        watcher.mount({
          dbPath,
          onDbFileChangeHook: () =>
            this.requestCheck(dbPath === session.profileInfo.dbPath ? 'profile' : 'group'),
        }),
      );
    }
    // 初始仅记录名册，不扫描群成员或发起在线请求。
    void withDatabaseSignal(this.lifetime.signal, () => services.profile.listBuddies())
      .then((rows) => {
        if (this.isCurrent()) this.roster = new Map(rows.map((row) => [row.uid, String(row.uin)]));
      })
      .catch(() => {});
    this.requestCheck('group');
    this.requestCheck('profile');
  }

  private isCurrent(): boolean {
    return !this.disposed && !this.lifetime.signal.aborted && this.current();
  }

  private assertCurrent(): void {
    this.lifetime.signal.throwIfAborted();
    databaseRequestSignal()?.throwIfAborted();
    if (!this.isCurrent()) throw new DOMException('账号已切换', 'AbortError');
  }

  async snapshot() {
    return {
      ...(await this.cache.snapshot()),
      ...this.status(),
    };
  }

  async localTimes(kind: 'friends' | 'groups') {
    this.assertCurrent();
    const result = await withDatabasePriority(
      'background',
      () => this.timeReaders[kind].read(),
      this.lifetime.signal,
    );
    this.assertCurrent();
    return result;
  }
  cachedProfiles() {
    this.assertCurrent();
    return this.services.intentSense.cachedProfileSummaries();
  }
  async localJoins() {
    return withDatabasePriority(
      'background',
      async () => {
        this.assertCurrent();
        const times = await this.session.groupMembers.selfJoinTimes(this.selfUid, this.scope.uin);
        this.assertCurrent();
        return times;
      },
      this.lifetime.signal,
    );
  }

  /** 进度校准不复制整份联系人指标缓存。 */
  status() {
    return {
      taskId: this.taskId,
      target: this.target,
      relationGraphRevision: this.relationGraphRevision,
      progress: this.preparing
        ? { ...this.cache.progress, status: 'running' as const, phase: '本地资料' }
        : { ...this.cache.progress },
    };
  }

  private appendLog(message: string, stage = 'task') {
    this.logs = [
      ...this.logs,
      {
        ts: Date.now(),
        seq: ++this.logSequence,
        stage,
        level: message.includes('失败：') ? ('error' as const) : ('info' as const),
        text: message,
      },
    ].slice(-200);
    if (this.taskId)
      backgroundTasks.update(this.taskId, { details: this.taskDetails(), logs: this.logs });
  }
  private taskDetails() {
    return [...this.summaries.values()];
  }

  private async summarizeFriend(uin: string, uid: string) {
    this.assertCurrent();
    const byUin = await this.cache.row(`friend:${uin}`);
    this.assertCurrent();
    const byUid = await this.cache.row(`friend:${uid}`);
    this.assertCurrent();
    const values = {
      ...byUin,
      ...byUid,
    };
    this.summaries.set(
      `friend:${uin}`,
      `好友获取结果：${JSON.stringify({ QQ号: uin === uid ? null : uin, UID: uid, ...this.friendMeta.get(uin), 指标: formatMetrics(values) })}`,
    );
    this.appendLog(this.summaries.get(`friend:${uin}`)!, 'friends');
    if (this.taskId) backgroundTasks.update(this.taskId, { details: this.taskDetails() });
  }
  private async summarizeGroup(code: string) {
    this.assertCurrent();
    const values = await this.cache.row(`group:${code}`);
    this.assertCurrent();
    this.summaries.set(
      `group:${code}`,
      `群聊获取结果：${JSON.stringify({ 群号: code, ...this.groupMeta.get(code), 指标: formatMetrics(values) })}`,
    );
    this.appendLog(this.summaries.get(`group:${code}`)!, 'groups');
    if (this.taskId) backgroundTasks.update(this.taskId, { details: this.taskDetails() });
  }

  private async friends() {
    this.assertCurrent();
    const rows = await this.services.profile.listBuddies();
    this.assertCurrent();
    return rows.filter(
      (row) => validContactUid(row.uid) && row.uin > 0n && String(row.uin) !== this.scope.uin,
    );
  }

  private async conversationTargets() {
    this.assertCurrent();
    // 隐藏会话仍在 recent_contact 中；已删除会话需从独立列表补入。
    const [recent, deleted] = await Promise.all([
      this.services.recentContacts.getRecentContact(-1),
      this.services.deletedSessions.listDeletedSessions(),
    ]);
    this.assertCurrent();
    const users = new Map<string, RefreshContact>();
    for (const row of [...recent, ...deleted.filter((row) => row.resolvable)]) {
      const kind = classifyChatType(row.chatType);
      if (
        kind !== 'group' &&
        kind !== 'dataline' &&
        row.targetUid !== this.selfUid &&
        validContactUid(row.targetUid)
      ) {
        const rawUin = 'targetUin' in row ? String(row.targetUin) : '';
        const uin = /^[1-9]\d*$/.test(rawUin) ? BigInt(rawUin) : 0n;
        if (!users.has(row.targetUid) || uin > 0n)
          users.set(row.targetUid, { uid: row.targetUid, uin });
      }
    }
    return { users: [...users.values()] };
  }

  private async excludeLikeMetrics(
    profiles: Awaited<ReturnType<AccountServices['profile']['profilesByUids']>>,
  ) {
    this.assertCurrent();
    const excluded = profiles.filter((profile) => profile.isBot || profile.extInfo?.isEnterprise);
    await this.cache.removeMetrics(
      excluded.flatMap((profile) => [`friend:${profile.uid}`, `friend:${profile.uin}`]),
      ['likeCount'],
    );
    this.assertCurrent();
    return new Set(excluded.map((profile) => profile.uid));
  }

  private async friendJobs(
    only?: string[],
    force = true,
    fields?: ContactMetric[],
    report = false,
    maxAgeMs?: number,
    candidates: RefreshContact[] = [],
  ): Promise<ContactMetricJob[]> {
    this.assertCurrent();
    if (
      fields &&
      !fields.some((field) =>
        [
          'level',
          'likeCount',
          'addedAt',
          'direction',
          'commonFriends',
          'commonGroups',
          'energy',
          'schools',
          'source',
          'sourceGroup',
        ].includes(field),
      )
    )
      return [];
    const byUid = new Map(candidates.map((row) => [row.uid, row]));
    const buddies = await this.friends();
    this.assertCurrent();
    const buddyUids = new Set(buddies.map((friend) => friend.uid));
    for (const friend of buddies) byUid.set(friend.uid, friend);
    let friends = [...byUid.values()];
    const profiles =
      report || candidates.length || !fields || fields.includes('likeCount')
        ? await this.services.profile.profilesByUids(friends.map((friend) => friend.uid))
        : [];
    this.assertCurrent();
    const profilesByUid = new Map(profiles.map((profile) => [profile.uid, profile]));
    friends = friends
      .map((friend) => ({
        ...friend,
        uin: profilesByUid.get(friend.uid)?.uin || friend.uin,
      }))
      .filter((friend) => String(friend.uin) !== this.scope.uin);
    const excludedLikes = await this.excludeLikeMetrics(profiles);
    this.assertCurrent();
    if (report)
      for (const profile of profiles) {
        this.friendMeta.set(profile.uin > 0n ? String(profile.uin) : profile.uid, {
          昵称: profile.nick,
          备注: profile.remark,
          年龄: profile.age,
          出生年份: profile.birthYear,
          生日: `${profile.birthMonth}-${profile.birthDay}`,
          性别: profile.gender,
          亲密度: profile.intimacy,
          国家: profile.extInfo?.country,
          省份: profile.extInfo?.province,
          亲密关系: profile.extRelation?.displayId,
        });
      }
    const snapshot = force ? undefined : await this.cache.snapshot();
    this.assertCurrent();
    const jobs: ContactMetricJob[] = [];
    for (const friend of friends) {
      if (only && !only.includes(friend.uid)) continue;
      const uin = friend.uin > 0n ? String(friend.uin) : friend.uid,
        key = `friend:${uin}`;
      const row = snapshot?.rows[key];
      const needs = (metric: ContactMetric) =>
        (!fields || fields.includes(metric)) && needsMetricRefresh(row?.[metric], force, maxAgeMs);
      if (friend.uin > 0n && needs('level'))
        jobs.push({ key: `${key}:level`, run: () => this.services.peerStats.getQqLevel(uin, 1) });
      if (friend.uin > 0n && needs('energy'))
        jobs.push({ key: `${key}:energy`, run: () => this.services.profileExtras.energy(uin) });
      if (friend.uin > 0n && needs('schools'))
        jobs.push({
          key: `${key}:schools`,
          run: () => this.services.profileExtras.educationHistory(uin),
        });
      const missingIdentity = (
        ['level', 'commonFriends', 'commonGroups', 'energy', 'schools'] as const
      ).filter((metric) => friend.uin <= 0n && needs(metric));
      if (missingIdentity.length)
        jobs.push({
          key: `${key}:identity`,
          run: async () => {
            const error = new Error('本地资料及会话未提供 QQ 号，无法查询该项指标');
            for (const metric of missingIdentity) await this.cache.failed(key, metric, error);
            throw error;
          },
        });
      if (
        !excludedLikes.has(friend.uid) &&
        (!fields || fields.includes('likeCount')) &&
        needsMetricRefresh(snapshot?.rows[`friend:${friend.uid}`]?.likeCount, force, maxAgeMs)
      )
        jobs.push({
          key: `${key}:likes`,
          run: () => this.services.peerStats.getLikeCount(friend.uid, 1),
        });
      if (
        buddyUids.has(friend.uid) &&
        (needs('addedAt') || needs('direction') || needs('source') || needs('sourceGroup'))
      )
        jobs.push({
          key: `${key}:clue`,
          run: async () => {
            const result = await this.services.accountWrite.friendClue(friend.uid, 1);
            const missing = [
              needs('addedAt') && result.addedAt === null ? '添加时间' : '',
              needs('direction') && result.direction === null ? '添加方向' : '',
            ].filter(Boolean);
            if (missing.length)
              this.appendLog(`${key} 部分字段未取得：${missing.join('、')}`, 'friends');
            if (
              (needs('addedAt') || needs('direction')) &&
              (!needs('addedAt') || result.addedAt === null) &&
              (!needs('direction') || result.direction === null)
            )
              throw new Error('好友线索部分字段未知');
          },
        });
      if (friend.uin > 0n && (needs('commonFriends') || needs('commonGroups')))
        jobs.push({
          key: `${key}:common`,
          run: async () => {
            const result = await this.services.accountWrite.commonRelationships(uin, 1);
            const friendMissing = !!result.friendError || result.friendCount === null;
            const groupMissing = !!result.groupError || result.groups === null;
            if (
              (needs('commonFriends') && friendMissing) ||
              (needs('commonGroups') && groupMissing)
            )
              this.appendLog(
                `${key} 部分字段未取得：${[
                  needs('commonFriends') && friendMissing ? '共同好友数' : '',
                  needs('commonGroups') && groupMissing ? '共同群聊' : '',
                ]
                  .filter(Boolean)
                  .join('、')}`,
                'friends',
              );
            if (
              (!needs('commonFriends') || friendMissing) &&
              (!needs('commonGroups') || groupMissing)
            )
              throw new Error('共同关系部分字段读取失败');
          },
        });
    }
    const grouped = new Map<string, ContactMetricJob[]>();
    for (const job of jobs) {
      const key = job.key.split(':').slice(0, 2).join(':');
      const list = grouped.get(key) ?? [];
      list.push(job);
      grouped.set(key, list);
    }
    return [...grouped].map(([key, work]) => {
      const uin = key.slice('friend:'.length),
        uid = friends.find(
          (friend) => (friend.uin > 0n ? String(friend.uin) : friend.uid) === uin,
        )!.uid;
      const completed = new Set<string>();
      return {
        key,
        label: `好友 ${this.friendMeta.get(uin)?.昵称 ?? ''}（${uin}）`,
        run: async () => {
          this.assertCurrent();
          const failures: string[] = [];
          try {
            for (const job of work) {
              this.assertCurrent();
              if (completed.has(job.key)) continue;
              if (!this.online()) throw new ContactMetricsOfflineError('QQ 暂不可在线查询');
              try {
                await job.run();
                this.assertCurrent();
                completed.add(job.key);
              } catch (error) {
                this.assertCurrent();
                if (error instanceof ContactMetricsOfflineError) throw error;
                failures.push(
                  `${job.key.split(':').at(-1)}：${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          } finally {
            if (report && this.isCurrent()) await this.summarizeFriend(uin, uid);
          }
          if (failures.length) {
            if (!completed.size) throw new Error(failures.join('；'));
            this.appendLog(`${key} 部分字段未取得：${failures.join('；')}`, 'friends');
          }
        },
      };
    });
  }

  private async groupFriends(code: string) {
    this.assertCurrent();
    const buddies = new Set((await this.friends()).map((friend) => friend.uid));
    this.assertCurrent();
    const directory = await this.services.groupInfo.listGroupDirectory();
    this.assertCurrent();
    const expected = directory.find((row) => row.groupCode === code)?.memberCount;
    const local = await this.services.groupInfo.listExportMembers(BigInt(code));
    this.assertCurrent();
    let members = local;
    if (
      expected === undefined ||
      expected <= 0 ||
      local.length !== expected ||
      local.some((row) => !validContactUid(row.uid))
    ) {
      if (!this.online()) throw new ContactMetricsOfflineError('群成员需要在线补齐');
      const onlineMembers = await this.services.groupInfo.fetchOnlineMembers(Number(code), {
        force: true,
        priority: 1,
      });
      this.assertCurrent();
      members = onlineMembers.map((row) => ({
        uid: row.uid,
        uin: String(row.uin),
        name: row.nickname,
        categoryId: 0,
      }));
      if (members.some((row) => !validContactUid(row.uid))) throw new Error('群成员身份未完整返回');
    }
    const ids = new Set(members.map((row) => row.uid).filter(Boolean));
    const friendCount = [...ids].filter((uid) => buddies.has(uid)).length;
    await this.cache.record(`group:${code}`, { friendCount });
    this.assertCurrent();
    this.memberships.set(code, new Set([...ids].filter((uid) => buddies.has(uid))));
    return friendCount;
  }

  async rebuild(
    missingOnly = false,
    fields?: ContactMetric[],
    range: 'all' | 'older24h' = 'all',
    target: 'metrics' | 'groupMembers' = 'metrics',
  ) {
    if (this.disposed || !this.current()) throw new Error('账号已切换');
    if (
      this.preparing ||
      this.cache.progress.status === 'running' ||
      this.cache.progress.status === 'paused'
    ) {
      if (this.target !== target)
        throw new Error('另一范围的联系人刷新任务正在进行，请先完成或取消该任务');
      return this.taskId;
    }
    this.target = target;
    this.preparing = true;
    this.stopPreparing = false;
    this.logs = [];
    this.summaries.clear();
    this.friendMeta.clear();
    this.groupMeta.clear();
    this.logSequence = 0;
    if (this.taskId) backgroundTasks.setActions(this.taskId, []);
    this.taskId = backgroundTasks.start({
      name:
        target === 'groupMembers'
          ? '更新全部群成员并重算群交集'
          : missingOnly
            ? '补齐好友/群信息缓存'
            : '更新好友/群信息缓存',
      kind: 'contacts',
      scope: this.scope,
      statusLabel: '本地资料',
      progress: 0,
    });
    const id = this.taskId;
    this.appendLog('开始读取本地资料，旧缓存保留到新数据获取成功');
    backgroundTasks.setActions(id, [
      {
        id: 'stop',
        label: '取消',
        run: () => {
          this.stopPreparing = true;
          this.cache.cancel();
        },
      },
    ]);
    void withDatabaseSignal(this.lifetime.signal, async () => {
      try {
        this.assertCurrent();
        const maxAgeMs = range === 'older24h' ? 24 * 60 * 60 * 1000 : undefined;
        const targets = target === 'metrics' ? await this.conversationTargets() : undefined;
        this.assertCurrent();
        const jobs =
          target === 'groupMembers'
            ? []
            : await this.friendJobs(
                undefined,
                !missingOnly && range === 'all',
                fields,
                true,
                maxAgeMs,
                targets?.users,
              );
        this.assertCurrent();
        const includeGroups =
          target === 'groupMembers' ||
          !fields ||
          fields.some((field) =>
            ['friendCount', 'activityScore', 'joinedAt', 'grade', 'freezeState'].includes(field),
          );
        const groups = includeGroups ? await this.services.groupInfo.listGroupDirectory() : [];
        this.assertCurrent();
        if (target === 'groupMembers') {
          for (const group of groups)
            jobs.push({
              key: `group:${group.groupCode}`,
              label: `群成员名单（${group.groupCode}）`,
              run: async () => {
                this.assertCurrent();
                let count: number;
                try {
                  count = await this.services.groupInfo.refreshGroupMembers(group.groupCode);
                  this.assertCurrent();
                } catch (error) {
                  this.assertCurrent();
                  if (!this.online())
                    throw new ContactMetricsOfflineError('群成员更新等待 QQ 在线');
                  throw error;
                }
                this.summaries.set(
                  `group:${group.groupCode}`,
                  `群 ${group.groupCode}：已更新 ${count} 名成员`,
                );
                this.appendLog(this.summaries.get(`group:${group.groupCode}`)!, 'groups');
              },
            });
        } else {
          const snapshot = await this.cache.snapshot();
          this.assertCurrent();
          for (let offset = 0; includeGroups; offset += 500) {
            this.assertCurrent();
            const details = await this.services.groupInfo.listAllGroups(500, offset);
            this.assertCurrent();
            for (const group of details) {
              this.groupMeta.set(String(group.groupCode), {
                群名: group.groupName,
                备注: group.remark,
                人数: group.memberCount,
                群容量: group.maxMemberCount,
                创建时间: group.createTime,
              });
            }
            if (details.length < 500) break;
          }
          if (groups.length)
            for (const group of groups) {
              if (this.stopPreparing || this.disposed) break;
              if (
                !fields ||
                fields.some((field) => ['grade', 'freezeState', 'joinedAt'].includes(field))
              ) {
                const requested =
                  fields?.filter((field) => ['grade', 'freezeState', 'joinedAt'].includes(field)) ??
                  (['grade', 'freezeState', 'joinedAt'] as const);
                if (
                  requested.some((field) =>
                    needsMetricRefresh(
                      snapshot.rows[`group:${group.groupCode}`]?.[field],
                      !missingOnly && range === 'all',
                      maxAgeMs,
                    ),
                  )
                )
                  jobs.push({
                    key: `group:${group.groupCode}:profile`,
                    label: `群资料（${group.groupCode}）`,
                    run: async () => {
                      const errors: string[] = [];
                      if (requested.some((field) => field === 'grade' || field === 'freezeState')) {
                        try {
                          const result = await this.services.groupInfo.getExtendedProfile(
                            Number(group.groupCode),
                            true,
                            true,
                          );
                          if (result.error) throw new Error(result.error);
                        } catch (error) {
                          this.assertCurrent();
                          errors.push(error instanceof Error ? error.message : String(error));
                        }
                      }
                      if (requested.includes('joinedAt')) {
                        try {
                          const local = this.selfUid
                            ? await this.session.groupMembers.getMember(
                                BigInt(group.groupCode),
                                this.selfUid,
                              )
                            : (
                                await this.session.groupMembers.getMembersByUins(
                                  BigInt(group.groupCode),
                                  [BigInt(this.scope.uin)],
                                )
                              )[0];
                          this.assertCurrent();
                          let joinedAt = local?.memberFlag === 0 ? local.joinTime : null;
                          if (!joinedAt) {
                            const members = await this.services.groupInfo.fetchOnlineMembers(
                              Number(group.groupCode),
                              { priority: 1 },
                            );
                            this.assertCurrent();
                            joinedAt =
                              members.find(
                                (member) =>
                                  (Boolean(this.selfUid) && member.uid === this.selfUid) ||
                                  (!member.uid && String(member.uin) === this.scope.uin),
                              )?.joinTime ?? null;
                          }
                          await this.cache.project(`group:${group.groupCode}`, {
                            joinedAt: joinedAt && joinedAt > 0 ? joinedAt : null,
                          });
                        } catch (error) {
                          this.assertCurrent();
                          await this.cache.failed(`group:${group.groupCode}`, 'joinedAt', error);
                          errors.push(error instanceof Error ? error.message : String(error));
                        }
                      }
                      if (errors.length) throw new Error(errors.join('；'));
                    },
                  });
              }
              this.groupMeta.set(group.groupCode, {
                ...this.groupMeta.get(group.groupCode),
                人数: group.memberCount,
                我的身份: group.role,
                消息提醒方式: group.notifyLevel,
              });
              const groupFields: ContactMetric[] = fields?.filter(
                (field) => field === 'friendCount' || field === 'activityScore',
              ) ?? ['friendCount', 'activityScore'];
              if (
                groupFields.some((field) =>
                  needsMetricRefresh(
                    snapshot.rows[`group:${group.groupCode}`]?.[field],
                    !missingOnly && range === 'all',
                    maxAgeMs,
                  ),
                )
              )
                jobs.push({
                  key: `group:${group.groupCode}`,
                  label: `群 ${this.groupMeta.get(group.groupCode)?.群名 ?? ''}（${group.groupCode}）`,
                  online: false,
                  run: async () => {
                    let recordedScore = false;
                    try {
                      const score = this.groupMeta.get(group.groupCode)?.群活跃度;
                      if (
                        typeof score === 'number' &&
                        (!fields || fields.includes('activityScore'))
                      ) {
                        await this.cache.record(`group:${group.groupCode}`, {
                          activityScore: score,
                        });
                        recordedScore = true;
                      }
                      if (!fields || fields.includes('friendCount'))
                        await this.groupFriends(group.groupCode);
                    } catch (error) {
                      this.assertCurrent();
                      if (!(error instanceof ContactMetricsOfflineError))
                        await this.cache.failed(`group:${group.groupCode}`, 'friendCount', error);
                      if (error instanceof ContactMetricsOfflineError || !recordedScore)
                        throw error;
                      this.appendLog(
                        `group:${group.groupCode} 部分字段未取得：群内好友数；${error instanceof Error ? error.message : String(error)}`,
                        'groups',
                      );
                    } finally {
                      if (this.isCurrent()) await this.summarizeGroup(group.groupCode);
                    }
                  },
                });
            }
          for (let offset = 0; groups.length; offset += 500) {
            this.assertCurrent();
            const ext = await this.services.groupInfo.listAllGroupsExt(500, offset);
            this.assertCurrent();
            for (const row of ext) {
              const code = String(row.groupCode);
              this.groupMeta.set(code, {
                ...this.groupMeta.get(code),
                群活跃度: row.activityScore,
              });
            }
            if (ext.length < 500) break;
          }
        }
        this.assertCurrent();
        this.appendLog(`本地资料读取完成，准备 ${jobs.length} 项在线查询`);
        if (this.stopPreparing) {
          backgroundTasks.finish(id, 'cancelled');
          return;
        }
        this.cache.start(
          jobs.map((job) => ({
            ...job,
            run: () =>
              withDatabaseSignal(this.lifetime.signal, async () => {
                this.assertCurrent();
                const result = await job.run();
                this.assertCurrent();
                return result;
              }),
          })),
          target === 'groupMembers' ? '群成员名单' : '好友在线指标',
          target === 'groupMembers'
            ? async () => {
                this.assertCurrent();
                this.appendLog('群成员更新结束，开始重新计算群交集');
                await withDatabaseSignal(this.lifetime.signal, () =>
                  this.services.groupInfo.getRelationGraph({ force: true }),
                );
                if (!this.current() || this.disposed) return;
                this.relationGraphRevision++;
                this.appendLog('群交集已重新计算');
                this.cache.emit('relationGraphChanged');
              }
            : undefined,
        );
      } catch (error) {
        if (!this.isCurrent()) return;
        this.appendLog(`准备失败：${error instanceof Error ? error.message : String(error)}`);
        backgroundTasks.finish(id, 'failed', {
          note: error instanceof Error ? error.message : String(error),
          details: this.taskDetails(),
        });
        backgroundTasks.setActions(id, [
          {
            id: 'retry',
            label: '重新准备',
            run: () => this.rebuild(missingOnly, fields, range, target),
          },
        ]);
      } finally {
        this.preparing = false;
        if (this.isCurrent()) this.cache.emit('changed');
      }
    });
    return id;
  }

  private updateTask(progress: ContactMetricsProgress) {
    if (!this.taskId) return;
    const id = this.taskId;
    const patch = {
      progress: progress.total ? (progress.done / progress.total) * 100 : 100,
      statusLabel: progress.phase,
      note: `${progress.done}/${progress.total} 个对象，${progress.failed} 项未完成`,
      details: this.taskDetails(),
      logs: this.logs,
      subtasks: progress.lanes
        ? Object.entries(progress.lanes).map(([key, lane]) => ({
            label: key === 'friends' ? '好友' : '群聊',
            ...lane,
          }))
        : [],
    };
    if (progress.status === 'running') backgroundTasks.update(id, patch);
    else
      backgroundTasks.finish(id, progress.status, {
        ...patch,
        statusLabel:
          progress.status === 'failed'
            ? '部分完成'
            : progress.status === 'paused'
              ? '等待 QQ 在线'
              : undefined,
      });
    backgroundTasks.setActions(
      id,
      progress.status === 'running'
        ? [{ id: 'stop', label: '取消', run: () => this.cache.cancel() }]
        : progress.status === 'paused' ||
            progress.status === 'failed' ||
            progress.status === 'cancelled'
          ? [
              {
                id: 'retry',
                label: progress.status === 'failed' ? '仅重试失败项' : '继续',
                run: () => {
                  if (!this.current() || this.disposed) throw new Error('请回到原账号重新创建任务');
                  backgroundTasks.resume(id);
                  this.cache.resume();
                },
              },
            ]
          : [],
    );
  }

  private requestCheck(kind?: 'profile' | 'group') {
    if (!this.isCurrent()) return;
    if (kind) this.pendingKinds.add(kind);
    this.checkAgain = true;
    if (!this.timer && !this.checking)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void withDatabasePriority('background', () => this.checkChanges(), this.lifetime.signal);
      }, this.watchDelay);
  }

  private async checkChanges() {
    this.checking = true;
    this.checkAgain = false;
    const kinds = new Set(this.pendingKinds);
    this.pendingKinds.clear();
    try {
      this.assertCurrent();
      const friends = await this.friends();
      this.assertCurrent();
      const next = new Map(friends.map((row) => [row.uid, String(row.uin)]));
      const rosterChanged = [...new Set([...this.roster.keys(), ...next.keys()])].filter(
        (uid) => this.roster.get(uid) !== next.get(uid),
      );
      const addedFriends = rosterChanged.filter((uid) => next.has(uid) && !this.roster.has(uid));
      this.roster = next;
      if (kinds.has('profile')) {
        const cachedLikeUids = (await this.cache.keysForMetric('likeCount'))
          .filter((key) => key.startsWith('friend:u_'))
          .map((key) => key.slice('friend:'.length));
        this.assertCurrent();
        const profiles = await this.services.profile.profilesByUids([
          ...new Set([...next.keys(), ...cachedLikeUids]),
        ]);
        this.assertCurrent();
        await this.excludeLikeMetrics(profiles);
        this.assertCurrent();
        const signature = JSON.stringify(
          profiles.map((profile) => [
            profile.uid,
            profile.nick,
            profile.remark,
            profile.age,
            profile.birthYear,
            profile.birthMonth,
            profile.birthDay,
            profile.intimacy,
            profile.gender,
            profile.isBot,
            profile.extInfo?.isEnterprise,
            profile.extRelation,
            profile.extInfo?.country,
            profile.extInfo?.province,
          ]),
        );
        if (signature !== this.profileSignature || rosterChanged.length)
          this.cache.emit('baseChanged');
        this.profileSignature = signature;
      }
      if (!kinds.has('group') && !rosterChanged.length) return;
      const groups = await this.services.groupInfo.listGroupDirectory();
      this.assertCurrent();
      const codes = new Set(groups.map((group) => group.groupCode));
      const affected = new Set(rosterChanged.filter((uid) => next.has(uid)));
      const groupSetChanged =
        this.groupBaselineReady &&
        [...new Set([...codes, ...this.groupCodes])].some(
          (code) => codes.has(code) !== this.groupCodes.has(code),
        );
      if (groupSetChanged) for (const uid of next.keys()) affected.add(uid);
      this.groupCodes = codes;
      this.groupBaselineReady = true;
      if (kinds.has('group'))
        for (let offset = 0; ; offset += 500) {
          this.assertCurrent();
          const ext = await this.services.groupInfo.listAllGroupsExt(500, offset);
          this.assertCurrent();
          if (ext.length < 500) break;
        }
      const memberSnapshot = await this.services.groupInfo.contactMembershipSnapshot([
        ...next.keys(),
      ]);
      this.assertCurrent();
      for (const group of groups) {
        if (!this.current() || this.disposed) return;
        const summary = memberSnapshot.get(group.groupCode);
        const ids = summary?.friends ?? new Set<string>();
        const previous = this.memberships.get(group.groupCode);
        const delta = previous
          ? [...new Set([...ids, ...previous])].filter((uid) => ids.has(uid) !== previous.has(uid))
          : [];
        for (const uid of delta) if (next.has(uid)) affected.add(uid);
        this.memberships.set(group.groupCode, ids);
        if (summary?.total === group.memberCount && group.memberCount > 0) {
          await this.cache.recordIfChanged(`group:${group.groupCode}`, {
            friendCount: [...ids].filter((uid) => next.has(uid)).length,
          });
          this.assertCurrent();
        }
      }
      this.assertCurrent();
      this.cache.emit('baseChanged');
      await this.cache.stale(
        [...affected].flatMap((uid) => (next.has(uid) ? [`friend:${next.get(uid)}`] : [])),
        ['commonGroups', 'commonFriends'],
      );
      this.assertCurrent();
      if (this.online())
        for (const uid of affected) {
          if (!this.current() || this.disposed) return;
          const uin = next.get(uid);
          if (uin) {
            await this.services.accountWrite.commonRelationships(uin, 1);
            this.assertCurrent();
            const row = (await this.cache.snapshot()).rows[`friend:${uin}`];
            this.assertCurrent();
            if (row?.commonGroups?.state === 'stale' || row?.commonFriends?.state === 'stale')
              await this.services.accountWrite.commonRelationships(uin, 1);
          }
        }
      if (this.online() && addedFriends.length) {
        for (const job of await this.friendJobs(addedFriends, false, [
          'level',
          'likeCount',
          'addedAt',
          'direction',
        ])) {
          if (!this.current() || this.disposed || !this.online()) return;
          try {
            await job.run();
          } catch {
            /* 单个好友缺少在线字段不阻断其余更新。 */
          }
        }
      }
    } catch (error) {
      if (this.isCurrent() && !databaseRequestSignal()?.aborted)
        console.warn('[contacts] 增量校准失败', error);
    } finally {
      this.checking = false;
      if (this.checkAgain) this.requestCheck();
    }
  }

  async dispose() {
    this.stopHistoryCapture();
    this.stopProfileWatch?.();
    this.services.groupInfo.disposeGroupProfiles();
    this.disposed = true;
    this.lifetime.abort();
    this.stopPreparing = true;
    this.checkAgain = false;
    this.pendingKinds.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const watch of this.watches.splice(0)) watch.unmount();
    if (this.services.groupInfo.contactMembersObserved === this.memberObserver)
      this.services.groupInfo.contactMembersObserved = undefined;
    if (this.services.groupInfo.contactMetrics === this.cache)
      this.services.groupInfo.contactMetrics = undefined;
    if (this.services.accountWrite.contactMetrics === this.cache)
      this.services.accountWrite.contactMetrics = undefined;
    if (this.services.peerStats.contactMetrics === this.cache)
      this.services.peerStats.contactMetrics = undefined;
    if (this.services.profileExtras?.contactMetrics === this.cache)
      this.services.profileExtras.contactMetrics = undefined;
    if (this.taskId)
      backgroundTasks.finish(this.taskId, 'cancelled', { note: '账号已关闭，已保存完成的缓存' });
    if (this.taskId) backgroundTasks.setActions(this.taskId, []);
    try {
      await this.cache.dispose();
    } catch (error) {
      console.warn('[contacts] 关闭时缓存保存失败', error);
    }
    await this.history.dispose();
  }
}

import { eventTimeFormatter } from '@weq/time';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import {
  ContactMetricsService,
  ContactHistoryService,
  installContactHistoryCapture,
  installContentSearchCapture,
  ContactMetricsOfflineError,
  DirectoryTimeReader,
  JsonStore,
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
import { GroupDirectoryTimeCache } from './group_directory_times';
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
  grade: '群等级',
  freezeState: '冻结状态',
};
type RefreshJob = ContactMetricJob & { units?: string[] };
const refreshOptions = z.object({
  missingOnly: z.boolean(),
  fields: z
    .array(
      z.custom<ContactMetric>(
        (value) => typeof value === 'string' && Object.hasOwn(METRIC_NAMES, value),
      ),
    )
    .optional(),
  range: z.enum(['all', 'older24h']),
  target: z.enum(['metrics', 'groupMembers']),
});
const refreshCheckpoint = z.object({
  id: z.string().uuid(),
  options: refreshOptions,
  startedAt: z.number(),
  updatedAt: z.number(),
  status: z.enum(['running', 'paused', 'completed', 'failed', 'cancelled']),
  foreground: z.boolean().optional(),
  plan: z.record(z.string(), z.array(z.string())).optional(),
  done: z.array(z.string()),
  graphDone: z.boolean(),
  failures: z.array(
    z.object({ lane: z.enum(['friends', 'groups']), label: z.string(), error: z.string() }),
  ),
});
type RefreshCheckpoint = z.infer<typeof refreshCheckpoint>;
type RefreshOptions = z.infer<typeof refreshOptions>;
const GROUP_MEMBERSHIP_RECONCILE_MS = 30_000;
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
            ? eventTimeFormatter.format(cell.value * 1000)
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
  private readonly stopSearchCapture: () => void;
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
  private timerDueAt = 0;
  private nextGroupCheckAt = 0;
  private checking = false;
  private roster = new Map<string, string>();
  private rosterReady = false;
  private memberships = new Map<string, Set<string>>();
  private groupCodes = new Set<string>();
  private groupBaselineReady = false;
  private profileSignature = '';
  private pendingKinds = new Set<'profile' | 'group'>();
  private stopPreparing?: 'pause' | 'cancel';
  private readonly refreshStore: JsonStore<{ task?: RefreshCheckpoint }>;
  private refresh?: RefreshCheckpoint;
  private completed = new Set<string>();
  private needsRebuild = false;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private checkpointWrite = Promise.resolve();
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
  private readonly friendTimes: DirectoryTimeReader;
  private readonly groupTimes: GroupDirectoryTimeCache;
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
    private readonly groupReconcileInterval = GROUP_MEMBERSHIP_RECONCILE_MS,
  ) {
    this.scope = { uin: session.context.uin, configId };
    const source = createHash('sha256')
      .update(session.msgDbPath ?? session.profileInfo.dbPath)
      .digest('hex');
    this.refreshStore = new JsonStore<{ task?: RefreshCheckpoint }>(
      join(cacheDir, `refresh-task-${source}.json`),
      () => ({}),
      { normalize: (value) => z.object({ task: refreshCheckpoint.optional() }).parse(value) },
    );
    this.selfUid = session.selfUid;
    this.friendTimes = new DirectoryTimeReader(
      (cursor) => session.c2cMsgs.directoryTimePage(cursor),
      this.selfUid,
      session.context.uin,
    );
    const groupSourcePath = session.groupMsgs.sourcePath;
    const groupSource = createHash('sha256')
      .update(JSON.stringify([this.scope.uin, this.selfUid, configId, groupSourcePath ?? source]))
      .digest('hex');
    const readGroupTimes = <T>(read: () => Promise<T>) =>
      withDatabasePriority(
        'background',
        async () => {
          this.assertCurrent();
          const result = await read();
          this.assertCurrent();
          return result;
        },
        this.lifetime.signal,
      );
    this.groupTimes = new GroupDirectoryTimeCache(
      join(cacheDir, `group-directory-times-${groupSource}.json`),
      groupSourcePath,
      (codes) =>
        readGroupTimes(() =>
          session.groupMsgs.recentDirectoryTimes(codes, this.selfUid, this.scope.uin),
        ),
      (code) =>
        readGroupTimes(() => session.groupMsgs.directoryTimes(code, this.selfUid, this.scope.uin)),
      this.lifetime.signal,
    );
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
    this.stopSearchCapture = installContentSearchCapture(services, services.contentSearch, () =>
      this.isCurrent(),
    );
    this.cache = new ContactMetricsService(
      join(cacheDir, 'metrics.json'),
      () => this.online() && this.current(),
      { interval: 200, concurrency: 4 },
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
          if (self?.joinTime && self.joinTime > 1)
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
    this.restoreRefresh();
    this.stopProfileWatch = services.intentSense?.onCachedProfilesChanged?.(() => {
      if (this.isCurrent()) this.cache.emit('profilesChanged');
    });
    const friendSourcePath = session.c2cMsgs?.sourcePath;
    for (const dbPath of new Set([friendSourcePath, groupSourcePath])) {
      if (!dbPath) continue;
      this.watches.push(
        watcher.mount({
          dbPath,
          onDbFileChangeHook: () => {
            if (dbPath === friendSourcePath) this.friendTimes.invalidate();
            if (dbPath === groupSourcePath) this.groupTimes.invalidate();
          },
        }),
      );
    }
    for (const dbPath of new Set([session.profileInfo.dbPath, session.groupMembers.dbPath])) {
      this.watches.push(
        watcher.mount({
          dbPath,
          onDbFileChangeHook: () => {
            if (dbPath === session.profileInfo.dbPath) this.requestCheck('profile');
            if (dbPath === session.groupMembers.dbPath) this.requestCheck('group');
          },
        }),
      );
    }
    // 首轮统一建立基线，避免启动先读一次名册、随后校准再读一次。
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

  async localTimes() {
    this.assertCurrent();
    const result = await withDatabasePriority(
      'background',
      () => this.friendTimes.read(),
      this.lifetime.signal,
    );
    this.assertCurrent();
    return result;
  }
  async localGroupTimes(groupCodes: readonly string[]) {
    this.assertCurrent();
    const result = await this.groupTimes.read([...new Set(groupCodes)]);
    this.assertCurrent();
    return result;
  }
  prioritizeGroupTimes(groupCodes: readonly string[]) {
    if (this.isCurrent()) this.groupTimes.prioritize(groupCodes);
  }
  async localGroupMaxSeqs() {
    this.assertCurrent();
    const result = await withDatabasePriority(
      'background',
      () => this.session.groupMsgs.directoryMaxSeqs(),
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
        return Object.fromEntries(Object.entries(times).filter(([, value]) => value > 1));
      },
      this.lifetime.signal,
    );
  }

  /** 进度校准不复制整份联系人指标缓存。 */
  status() {
    const task = backgroundTasks.snapshot().find((item) => item.id === this.taskId);
    const groupGraph = this.target === 'groupMembers' && this.cache.progress.phase === '整理结果';
    return {
      taskId: this.taskId,
      target: this.target,
      foreground: task?.foreground,
      actions: task?.actions ?? [],
      statusLabel: task?.statusLabel,
      relationGraphRevision: this.relationGraphRevision,
      progress: this.preparing
        ? { ...this.cache.progress, status: 'running' as const, phase: '本地资料' }
        : {
            ...this.cache.progress,
            phase: groupGraph ? '重新计算群交集' : this.cache.progress.phase,
          },
    };
  }

  private refreshPresentation({ missingOnly, target }: RefreshOptions) {
    return {
      destination: target === 'groupMembers' ? ('group-intersection' as const) : undefined,
      name:
        target === 'groupMembers'
          ? '更新全部群成员并重算群交集'
          : missingOnly
            ? '补齐好友/群信息缓存'
            : '更新好友/群信息缓存',
      display: {
        action:
          target === 'groupMembers'
            ? '更新群成员名单'
            : missingOnly
              ? '补齐联系人信息'
              : '更新联系人信息',
        context: target === 'groupMembers' ? '全部群聊' : '好友资料、群资料',
      },
    };
  }

  private restoreRefresh() {
    const saved = this.refreshStore.data.task;
    if (!saved) return;
    const status = saved.status === 'running' ? 'paused' : saved.status;
    this.refresh = { ...saved, status, foreground: false };
    this.completed = new Set(saved.done);
    this.taskId = saved.id;
    this.target = saved.options.target;
    this.needsRebuild = status !== 'completed';
    const lanes = {
      friends: { done: 0, total: 0, failed: 0 },
      groups: { done: 0, total: 0, failed: 0 },
    };
    for (const key of Object.keys(saved.plan ?? {})) {
      const lane = lanes[key.startsWith('group:') ? 'groups' : 'friends'];
      lane.total++;
      if (this.completed.has(key)) lane.done++;
    }
    for (const failure of saved.failures) lanes[failure.lane].failed++;
    const done = lanes.friends.done + lanes.groups.done;
    const total = lanes.friends.total + lanes.groups.total;
    this.cache.progress = { status, done, total, failed: saved.failures.length, phase: '', lanes };
    backgroundTasks.project(
      {
        ...this.refreshPresentation(saved.options),
        id: saved.id,
        kind: 'contacts',
        scope: this.scope,
        startedAt: saved.startedAt,
        updatedAt: saved.updatedAt,
        status,
        statusLabel: status === 'paused' ? '等待继续' : undefined,
        progress: status === 'completed' ? 100 : total ? (100 * done) / total : 0,
        note: `已完成 ${done}/${total} 项，${saved.failures.length} 项失败`,
        contactFailures: saved.failures,
        subtasks: this.contactSubtasks(lanes),
        actions: [],
      },
      this.refreshActions(saved.id, status),
    );
  }

  /** 先保存已取得的资料，再发布引用这些结果的断点。 */
  private persistRefresh() {
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    const refresh = this.refresh;
    if (!refresh) return this.checkpointWrite;
    const snapshot = { ...refresh, done: [...this.completed] };
    const write = this.checkpointWrite
      .catch(() => {})
      .then(async () => {
        await this.cache.flush();
        this.refreshStore.replace({ task: snapshot }, true);
      });
    this.checkpointWrite = write;
    return write;
  }

  async backgroundRefresh(id: string) {
    const refresh = this.refresh;
    this.assertCurrent();
    if (refresh?.id !== id || refresh.options.target !== 'groupMembers')
      throw new Error('群成员更新批次已改变，请刷新');
    if (!refresh.foreground) return;
    refresh.foreground = false;
    try {
      await this.persistRefresh();
    } catch (error) {
      refresh.foreground = true;
      throw error;
    }
    backgroundTasks.setForeground(id, false);
    this.cache.emit('changed');
  }

  private saveRefreshSoon() {
    this.checkpointTimer ??= setTimeout(() => {
      void this.persistRefresh().catch((error: unknown) => this.refreshStorageError(error));
    }, 500);
  }

  private refreshStorageError(error: unknown) {
    console.warn('[contacts] 任务断点保存失败', error);
    this.appendLog('保存失败：联系人任务断点未写入，请检查缓存目录');
  }

  async removeRefreshTask(id: string) {
    if (this.refresh?.id !== id) return;
    // 移除排在已有写入之后，不能被旧快照写回。
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    const refresh = this.refresh;
    this.refresh = undefined;
    const write = this.checkpointWrite
      .catch(() => {})
      .then(() => {
        this.refreshStore.replace({}, true);
      });
    this.checkpointWrite = write;
    try {
      await write;
      if (this.taskId === id) this.taskId = undefined;
      if (!this.refresh)
        this.cache.progress = { status: 'completed', done: 0, total: 0, failed: 0, phase: '' };
      this.cache.emit('changed');
    } catch (error) {
      this.refresh ??= refresh;
      throw error;
    }
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
    batch = false,
    maxAgeMs?: number,
    candidates: RefreshContact[] = [],
    plan?: RefreshCheckpoint['plan'],
  ): Promise<RefreshJob[]> {
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
      batch || candidates.length || !fields || fields.includes('likeCount')
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
    if (batch)
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
        jobs.push({ key: `${key}:energy`, run: () => this.services.profileExtras.energy(uin, 1) });
      if (friend.uin > 0n && needs('schools'))
        jobs.push({
          key: `${key}:schools`,
          run: () => this.services.profileExtras.educationHistory(uin, 1),
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
            const result = await this.services.accountWrite.commonRelationships(
              uin,
              1,
              'attributes',
            );
            const friendMissing = result.attributeFriendCount === null;
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
    return [...grouped].flatMap<RefreshJob>(([key, candidates]) => {
      const allowed = plan?.[key];
      const work = plan ? candidates.filter((field) => allowed?.includes(field.key)) : candidates;
      if (!work.length) return [];
      const uin = key.slice('friend:'.length),
        uid = friends.find(
          (friend) => (friend.uin > 0n ? String(friend.uin) : friend.uid) === uin,
        )!.uid;
      const completed = batch ? this.completed : new Set<string>();
      return [
        {
          key,
          units: work.map((field) => field.key),
          label: `好友 ${this.friendMeta.get(uin)?.昵称 ?? ''}（${uin}）`,
          queueFields: batch,
          run: async (enqueue) => {
            this.assertCurrent();
            const failures: string[] = [];
            let attempted = false;
            const runField = async (job: ContactMetricJob) => {
              this.assertCurrent();
              if (completed.has(job.key)) return;
              if (!this.online()) throw new ContactMetricsOfflineError('QQ 暂不可在线查询');
              attempted = true;
              try {
                await job.run();
                this.assertCurrent();
                completed.add(job.key);
                if (batch) this.saveRefreshSoon();
              } catch (error) {
                this.assertCurrent();
                if (error instanceof ContactMetricsOfflineError) throw error;
                if (!this.online()) throw new ContactMetricsOfflineError('QQ 暂不可在线查询');
                return `${job.key.split(':').at(-1)}：${error instanceof Error ? error.message : String(error)}`;
              }
            };
            try {
              if (enqueue) {
                const remaining = work.filter((field) => !completed.has(field.key));
                const reads = remaining.map((field) =>
                  enqueue(() => withDatabaseSignal(this.lifetime.signal, () => runField(field))),
                );
                for (const result of await Promise.allSettled(reads)) {
                  if (result.status === 'rejected') throw result.reason;
                  if (result.value) failures.push(result.value);
                }
              } else {
                for (const job of work) {
                  const failure = await runField(job);
                  if (failure) failures.push(failure);
                }
              }
            } finally {
              if (batch && attempted && this.isCurrent()) await this.summarizeFriend(uin, uid);
            }
            if (failures.length) {
              if (!work.some((field) => completed.has(field.key)))
                throw new Error(failures.join('；'));
              this.appendLog(`${key} 部分字段未取得：${failures.join('；')}`, 'friends');
            }
          },
        },
      ];
    });
  }

  async groupFriendSources(code: string) {
    this.assertCurrent();
    const [buddies, groups, members] = await Promise.all([
      this.friends(),
      this.services.groupInfo.listGroupDirectory(),
      this.services.groupInfo.listExportMembers(BigInt(code)),
    ]);
    this.assertCurrent();
    const memberUids = new Set(members.map(({ uid }) => uid).filter(validContactUid));
    const expected = groups.find((group) => group.groupCode === code)?.memberCount;
    const rosterComplete = Boolean(expected && expected === memberUids.size);
    const friends = [
      ...new Map(
        buddies.filter(({ uid }) => memberUids.has(uid)).map((row) => [row.uid, row]),
      ).values(),
    ];
    const addedUids: string[] = [];
    const pendingUids: string[] = [];
    let unknown = 0;
    const oldest = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const clues = await Promise.all(friends.map(({ uin }) => this.cache.row(`friend:${uin}`)));
    this.assertCurrent();
    for (const [index, { uid }] of friends.entries()) {
      const { addedAt, source, sourceGroup } = clues[index]!;
      if (
        typeof source?.value !== 'string' ||
        typeof sourceGroup?.value !== 'string' ||
        source.state === 'failed' ||
        sourceGroup.state === 'failed' ||
        (source.updatedAt ?? 0) < oldest ||
        (sourceGroup.updatedAt ?? 0) < (source.updatedAt ?? 0) ||
        (addedAt?.updatedAt ?? 0) > (source.updatedAt ?? 0)
      ) {
        pendingUids.push(uid);
      } else if (sourceGroup.value === code) {
        addedUids.push(uid);
      } else if (
        !sourceGroup.value &&
        (!source.value.trim() || /未知|群聊|群名片|群成员/.test(source.value))
      ) {
        unknown++;
      }
    }
    return {
      friendUids: friends.map(({ uid }) => uid),
      rosterComplete,
      addedUids,
      pendingUids,
      unknown,
    };
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
    foreground = false,
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
    const options = { missingOnly, fields, range, target };
    const showInPage = target === 'groupMembers' && foreground;
    this.target = target;
    this.needsRebuild = true;
    this.completed = new Set();
    this.logs = [];
    this.summaries.clear();
    this.friendMeta.clear();
    this.groupMeta.clear();
    this.logSequence = 0;
    if (this.taskId) backgroundTasks.setActions(this.taskId, []);
    this.taskId = backgroundTasks.start({
      ...this.refreshPresentation(options),
      kind: 'contacts',
      scope: this.scope,
      foreground: showInPage,
      statusLabel: '本地资料',
      progress: 0,
    });
    const id = this.taskId;
    const now = Date.now();
    this.refresh = {
      id,
      options,
      startedAt: now,
      updatedAt: now,
      status: 'running',
      foreground: showInPage,
      done: [],
      graphDone: false,
      failures: [],
    };
    this.prepareRefresh(this.refresh);
    return id;
  }

  private prepareRefresh(refresh: RefreshCheckpoint) {
    this.preparing = true;
    this.stopPreparing = undefined;
    this.cache.progress = { ...this.cache.progress, status: 'running', phase: '本地资料' };
    const {
      id,
      options: { missingOnly, fields, range, target },
    } = refresh;
    const plan = refresh.plan;
    this.appendLog('开始读取本地资料，旧缓存保留到新数据获取成功');
    backgroundTasks.setActions(id, this.refreshActions(id, 'running'));
    void withDatabaseSignal(this.lifetime.signal, async () => {
      try {
        await this.persistRefresh();
        this.assertCurrent();
        const maxAgeMs = !plan && range === 'older24h' ? 24 * 60 * 60 * 1000 : undefined;
        const force = Boolean(plan) || (!missingOnly && range === 'all');
        const targets = target === 'metrics' ? await this.conversationTargets() : undefined;
        this.assertCurrent();
        const jobs: RefreshJob[] =
          target === 'groupMembers'
            ? []
            : await this.friendJobs(undefined, force, fields, true, maxAgeMs, targets?.users, plan);
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
              const name = this.groupMeta.get(group.groupCode)?.群名;
              const label = name ? `${name}（${group.groupCode}）` : `群 ${group.groupCode}`;
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
                      force,
                      maxAgeMs,
                    ),
                  )
                )
                  jobs.push({
                    key: `group:${group.groupCode}:profile`,
                    label: `${label} · 群扩展资料`,
                    run: async () => {
                      const result = await this.services.groupInfo.getExtendedProfile(
                        Number(group.groupCode),
                        true,
                        true,
                        1,
                      );
                      this.assertCurrent();
                      if (result.error) throw new Error(result.error);
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
                    force,
                    maxAgeMs,
                  ),
                )
              )
                jobs.push({
                  key: `group:${group.groupCode}`,
                  label: `${label} · 群聊指标`,
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
        if (this.stopPreparing) {
          this.finishPreparing(refresh, this.stopPreparing === 'pause' ? 'paused' : 'cancelled');
          return;
        }
        if (!plan) refresh.plan = Object.fromEntries(jobs.map((job) => [job.key, job.units ?? []]));
        const byKey = new Map(jobs.map((job) => [job.key, job]));
        const keys = Object.keys(refresh.plan!);
        const completed = keys.filter((key) => this.completed.has(key));
        const pending = keys
          .filter((key) => !this.completed.has(key))
          .map((key): RefreshJob => {
            const job = byKey.get(key);
            if (
              job &&
              (refresh.plan?.[key] ?? []).every(
                (unit) => this.completed.has(unit) || job.units?.includes(unit),
              )
            )
              return job;
            return {
              key,
              online: false,
              run: async () => {
                throw new Error('原任务的联系人或资料范围已变化');
              },
            };
          });
        await this.persistRefresh();
        this.assertCurrent();
        if (this.stopPreparing) {
          this.finishPreparing(refresh, this.stopPreparing === 'pause' ? 'paused' : 'cancelled');
          return;
        }
        this.appendLog(`本地资料读取完成，准备 ${pending.length} 项查询`);
        this.needsRebuild = false;
        this.cache.start(
          pending.map<ContactMetricJob>((job) => ({
            ...job,
            run: (enqueue) =>
              withDatabaseSignal(this.lifetime.signal, async () => {
                this.assertCurrent();
                const result = await job.run(enqueue);
                this.assertCurrent();
                this.completed.add(job.key);
                if (target === 'groupMembers') refresh.graphDone = false;
                return result;
              }),
          })),
          target === 'groupMembers' ? '群成员名单' : '好友在线指标',
          target === 'groupMembers'
            ? async () => {
                this.assertCurrent();
                if (refresh.graphDone) return;
                this.appendLog('群成员更新结束，开始重新计算群交集');
                await withDatabaseSignal(this.lifetime.signal, () =>
                  this.services.groupInfo.getRelationGraph({ force: true }),
                );
                if (!this.current() || this.disposed) return;
                refresh.graphDone = true;
                this.relationGraphRevision++;
                this.appendLog('群交集已重新计算');
                this.cache.emit('relationGraphChanged');
              }
            : undefined,
          completed,
        );
      } catch (error) {
        if (!this.isCurrent()) return;
        this.appendLog(`准备失败：${error instanceof Error ? error.message : String(error)}`);
        this.finishPreparing(
          refresh,
          'failed',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        this.preparing = false;
        if (this.isCurrent()) this.cache.emit('changed');
      }
    });
  }

  private finishPreparing(
    refresh: RefreshCheckpoint,
    status: 'paused' | 'cancelled' | 'failed',
    note?: string,
  ) {
    refresh.status = status;
    this.cache.progress = { ...this.cache.progress, status };
    backgroundTasks.finish(refresh.id, status, { note, details: this.taskDetails() });
    backgroundTasks.setActions(refresh.id, this.refreshActions(refresh.id, status));
    refresh.updatedAt =
      backgroundTasks.snapshot().find((task) => task.id === refresh.id)?.updatedAt ?? Date.now();
    void this.persistRefresh().catch((error: unknown) => this.refreshStorageError(error));
  }

  private contactSubtasks(lanes: ContactMetricsProgress['lanes']) {
    return lanes
      ? Object.entries(lanes).map(([key, lane]) => ({
          label: key === 'friends' ? '好友' : '群聊',
          ...lane,
        }))
      : [];
  }

  private refreshActions(id: string, status: ContactMetricsProgress['status']) {
    const assertTask = () => {
      if (!this.isCurrent() || this.refresh?.id !== id) throw new Error('请回到原账号和数据源继续');
      return this.refresh;
    };
    const stop = (mode: 'pause' | 'cancel') => {
      const current = assertTask();
      if (this.preparing) {
        this.stopPreparing = mode;
        backgroundTasks.update(id, { statusLabel: mode === 'pause' ? '暂停收尾中' : '取消收尾中' });
        backgroundTasks.setActions(id, []);
      } else if (mode === 'pause') this.cache.pause();
      else if (this.needsRebuild) {
        backgroundTasks.resume(id);
        this.finishPreparing(current, 'cancelled');
      } else this.cache.cancel();
    };
    if (status === 'running')
      return [
        { id: 'pause', label: '暂停', run: () => stop('pause') },
        { id: 'stop', label: '取消', run: () => stop('cancel') },
      ];
    if (status === 'completed') return [];
    const retry = {
      id: status === 'paused' ? 'resume' : 'retry',
      label:
        status === 'paused'
          ? '继续'
          : this.needsRebuild && !this.refresh?.plan
            ? '重新准备'
            : status === 'failed'
              ? '仅重试失败项'
              : '继续',
      run: () => {
        const current = assertTask();
        current.status = 'running';
        backgroundTasks.resume(id);
        if (this.needsRebuild) this.prepareRefresh(current);
        else this.cache.resume();
      },
    };
    return status === 'paused'
      ? [retry, { id: 'stop', label: '取消', run: () => stop('cancel') }]
      : [retry];
  }

  private updateTask(progress: ContactMetricsProgress) {
    const refresh = this.refresh;
    if (!refresh || this.disposed) return;
    const id = refresh.id;
    refresh.status = progress.status;
    refresh.failures = this.cache.failedItems();
    const patch = {
      progress: progress.total ? (progress.done / progress.total) * 100 : 100,
      statusLabel: this.cache.pausing ? '暂停收尾中' : progress.phase,
      note: `已处理 ${progress.done}/${progress.total} 项，${progress.failed} 项失败`,
      details: this.taskDetails(),
      logs: this.logs,
      contactFailures: refresh.failures,
      subtasks: this.contactSubtasks(progress.lanes),
    };
    if (progress.status === 'running') backgroundTasks.update(id, patch);
    else
      backgroundTasks.finish(id, progress.status, {
        ...patch,
        statusLabel:
          progress.status === 'failed'
            ? '部分完成'
            : progress.status === 'paused'
              ? this.cache.pausing
                ? '已暂停'
                : '等待 QQ 在线'
              : undefined,
      });
    backgroundTasks.setActions(
      id,
      progress.status === 'running' && this.cache.pausing
        ? []
        : this.refreshActions(id, progress.status),
    );
    if (progress.status === 'running') this.saveRefreshSoon();
    else {
      refresh.updatedAt =
        backgroundTasks.snapshot().find((task) => task.id === id)?.updatedAt ?? Date.now();
      void this.persistRefresh().catch((error: unknown) => this.refreshStorageError(error));
    }
  }

  private requestCheck(kind?: 'profile' | 'group') {
    if (!this.isCurrent()) return;
    if (kind) this.pendingKinds.add(kind);
    if (this.checking || !this.pendingKinds.size) return;
    const now = performance.now();
    const earliest = now + this.watchDelay;
    const due = this.pendingKinds.has('profile')
      ? earliest
      : Math.max(earliest, this.nextGroupCheckAt);
    if (this.timer && this.timerDueAt <= due) return;
    clearTimeout(this.timer);
    this.timerDueAt = due;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void withDatabasePriority('background', () => this.checkChanges(), this.lifetime.signal);
      },
      Math.ceil(due - now),
    );
    this.timer.unref?.();
  }

  private async checkChanges() {
    if (!this.isCurrent()) return;
    const kinds = new Set(this.pendingKinds);
    if (performance.now() < this.nextGroupCheckAt) kinds.delete('group');
    if (!kinds.size) {
      this.requestCheck();
      return;
    }
    this.checking = true;
    for (const kind of kinds) this.pendingKinds.delete(kind);
    try {
      this.assertCurrent();
      const next =
        kinds.has('profile') || !this.rosterReady
          ? new Map((await this.friends()).map((row) => [row.uid, String(row.uin)]))
          : this.roster;
      const rosterChanged =
        this.rosterReady && next !== this.roster
          ? [...new Set([...this.roster.keys(), ...next.keys()])].filter(
              (uid) => this.roster.get(uid) !== next.get(uid),
            )
          : [];
      const addedFriends = rosterChanged.filter((uid) => next.has(uid) && !this.roster.has(uid));
      const changedFriendKeys = rosterChanged.flatMap((uid) =>
        [this.roster.get(uid), next.get(uid)].flatMap((uin) => (uin ? [`friend:${uin}`] : [])),
      );
      this.roster = next;
      this.rosterReady = true;
      if (changedFriendKeys.length) {
        await this.cache.removeMetrics(
          [...new Set(changedFriendKeys)],
          ['addedAt', 'direction', 'source', 'sourceGroup'],
        );
        this.assertCurrent();
      }
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
      // 好友名册发生变化时及时重算交集，并合并已经等待的群资料校准。
      if (this.pendingKinds.delete('group')) kinds.add('group');
      this.nextGroupCheckAt = performance.now() + this.groupReconcileInterval;
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
      const memberSnapshot = await this.services.groupInfo.contactMembershipSnapshot(
        [...next.keys()],
        [...codes],
      );
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
            await this.services.accountWrite.commonRelationships(uin, 1, 'attributes');
            this.assertCurrent();
            const row = (await this.cache.snapshot()).rows[`friend:${uin}`];
            this.assertCurrent();
            if (row?.commonGroups?.state === 'stale' || row?.commonFriends?.state === 'stale')
              await this.services.accountWrite.commonRelationships(uin, 1, 'attributes');
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
      this.requestCheck();
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.stopSearchCapture();
    this.stopHistoryCapture();
    this.stopProfileWatch?.();
    this.services.groupInfo.disposeGroupProfiles();
    this.disposed = true;
    this.lifetime.abort();
    this.groupTimes.flush();
    this.stopPreparing = 'cancel';
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
    if (this.taskId) {
      backgroundTasks.finish(this.taskId, 'cancelled');
      backgroundTasks.setActions(this.taskId, []);
    }
    if (this.refresh?.status === 'running') this.refresh.status = 'paused';
    await this.cache
      .dispose()
      .catch((error: unknown) => console.warn('[contacts] 关闭时缓存保存失败', error));
    try {
      await this.persistRefresh();
    } catch (error) {
      console.warn('[contacts] 关闭时任务断点保存失败', error);
    }
    await this.history.dispose();
  }
}

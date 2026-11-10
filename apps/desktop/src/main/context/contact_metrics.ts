import { join } from 'node:path';
import {
  ContactMetricsService,
  ContactMetricsOfflineError,
  type ContactMetric,
  type ContactMetricRows,
  type ContactMetricJob,
  type ContactMetricsProgress,
  type DbWatchService,
} from '@weq/service';
import { withDatabasePriority } from '@weq/db';
import type { AccountSession } from '@weq/account';
import type { AccountServices } from './app_context';
import { backgroundTasks } from '../background_tasks';
const validContactUid = (uid: string) => /^u_[A-Za-z0-9_-]+$/.test(uid);

const METRIC_NAMES: Record<ContactMetric, string> = {
  level: 'QQ 等级',
  likeCount: '获赞数',
  addedAt: '添加时间',
  direction: '添加方向',
  commonFriends: '共同好友数',
  commonGroups: '共同群聊',
  friendCount: '群内好友数',
  activityScore: '群活跃度',
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
  taskId?: string;
  private target: 'metrics' | 'groupMembers' = 'metrics';
  private relationGraphRevision = 0;
  private preparing = false;
  private disposed = false;
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

  constructor(
    private readonly services: AccountServices,
    session: AccountSession,
    cacheDir: string,
    watcher: DbWatchService,
    private readonly online: () => boolean,
    private readonly current: () => boolean,
    configId: string,
    private readonly watchDelay = 2000,
  ) {
    this.scope = { uin: session.context.uin, configId };
    services.groupInfo.setMemberRosterCache(join(cacheDir, 'group-members'));
    this.cache = new ContactMetricsService(
      join(cacheDir, 'metrics.json'),
      () => this.online() && this.current(),
    );
    services.accountWrite.contactMetrics = this.cache;
    services.peerStats.contactMetrics = this.cache;
    services.groupInfo.contactMetrics = this.cache;
    services.groupInfo.contactMembersObserved = async (groupId, members) => {
      if (this.disposed || !this.current()) return;
      if (members.some((member) => !validContactUid(member.uid))) return;
      const buddies = new Set((await this.friends()).map((friend) => friend.uid));
      const ids = new Set(members.map((member) => member.uid).filter((uid) => buddies.has(uid)));
      await this.cache.record(`group:${groupId}`, { friendCount: ids.size });
      this.memberships.set(String(groupId), ids);
    };
    this.cache.on('progress', (progress: ContactMetricsProgress) => this.updateTask(progress));
    this.cache.on('log', (message: string, stage?: string) => this.appendLog(message, stage));
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
    void services.profile
      .listBuddies()
      .then((rows) => {
        if (!this.disposed) this.roster = new Map(rows.map((row) => [row.uid, String(row.uin)]));
      })
      .catch(() => {});
    this.requestCheck('group');
    this.requestCheck('profile');
  }

  async snapshot() {
    return {
      ...(await this.cache.snapshot()),
      ...this.status(),
    };
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
    const values = {
      ...(await this.cache.row(`friend:${uin}`)),
      ...(await this.cache.row(`friend:${uid}`)),
    };
    this.summaries.set(
      `friend:${uin}`,
      `好友获取结果：${JSON.stringify({ QQ号: uin, UID: uid, ...this.friendMeta.get(uin), 指标: formatMetrics(values) })}`,
    );
    this.appendLog(this.summaries.get(`friend:${uin}`)!, 'friends');
    if (this.taskId) backgroundTasks.update(this.taskId, { details: this.taskDetails() });
  }
  private async summarizeGroup(code: string) {
    this.summaries.set(
      `group:${code}`,
      `群聊获取结果：${JSON.stringify({ 群号: code, ...this.groupMeta.get(code), 指标: formatMetrics(await this.cache.row(`group:${code}`)) })}`,
    );
    this.appendLog(this.summaries.get(`group:${code}`)!, 'groups');
    if (this.taskId) backgroundTasks.update(this.taskId, { details: this.taskDetails() });
  }

  private async friends() {
    const rows = await this.services.profile.listBuddies();
    return rows.filter(
      (row) => validContactUid(row.uid) && row.uin > 0n && String(row.uin) !== this.scope.uin,
    );
  }

  private async excludeLikeMetrics(
    profiles: Awaited<ReturnType<AccountServices['profile']['profilesByUids']>>,
  ) {
    const excluded = profiles.filter((profile) => profile.isBot || profile.extInfo?.isEnterprise);
    await this.cache.removeMetrics(
      excluded.flatMap((profile) => [`friend:${profile.uid}`, `friend:${profile.uin}`]),
      ['likeCount'],
    );
    return new Set(excluded.map((profile) => profile.uid));
  }

  private async friendJobs(
    only?: string[],
    force = true,
    fields?: ContactMetric[],
    report = false,
    maxAgeMs?: number,
  ): Promise<ContactMetricJob[]> {
    if (
      fields &&
      !fields.some((field) =>
        ['level', 'likeCount', 'addedAt', 'direction', 'commonFriends', 'commonGroups'].includes(
          field,
        ),
      )
    )
      return [];
    const friends = await this.friends();
    const profiles =
      report || !fields || fields.includes('likeCount')
        ? await this.services.profile.profilesByUids(friends.map((friend) => friend.uid))
        : [];
    const excludedLikes = await this.excludeLikeMetrics(profiles);
    if (report)
      for (const profile of profiles) {
        this.friendMeta.set(String(profile.uin), {
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
    const jobs: ContactMetricJob[] = [];
    for (const friend of friends) {
      if (only && !only.includes(friend.uid)) continue;
      const uin = String(friend.uin),
        key = `friend:${uin}`;
      const row = snapshot?.rows[key];
      const needs = (
        metric: 'level' | 'addedAt' | 'direction' | 'commonFriends' | 'commonGroups',
      ) =>
        (!fields || fields.includes(metric)) && needsMetricRefresh(row?.[metric], force, maxAgeMs);
      if (needs('level'))
        jobs.push({ key: `${key}:level`, run: () => this.services.peerStats.getQqLevel(uin, 1) });
      if (
        !excludedLikes.has(friend.uid) &&
        (!fields || fields.includes('likeCount')) &&
        needsMetricRefresh(snapshot?.rows[`friend:${friend.uid}`]?.likeCount, force, maxAgeMs)
      )
        jobs.push({
          key: `${key}:likes`,
          run: () => this.services.peerStats.getLikeCount(friend.uid, 1),
        });
      if (needs('addedAt') || needs('direction'))
        jobs.push({
          key: `${key}:clue`,
          run: async () => {
            const result = await this.services.accountWrite.friendClue(friend.uid, 1);
            if (result.addedAt === null || result.direction === null)
              throw new Error('好友线索部分字段未知');
          },
        });
      if (needs('commonFriends') || needs('commonGroups'))
        jobs.push({
          key: `${key}:common`,
          run: async () => {
            const result = await this.services.accountWrite.commonRelationships(uin, 1);
            if (
              result.friendError ||
              result.groupError ||
              result.friendCount === null ||
              result.groups === null
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
        uid = friends.find((friend) => String(friend.uin) === uin)!.uid;
      const completed = new Set<string>();
      return {
        key,
        label: `好友 ${this.friendMeta.get(uin)?.昵称 ?? ''}（${uin}）`,
        run: async () => {
          const failures: string[] = [];
          try {
            for (const job of work) {
              if (completed.has(job.key)) continue;
              if (!this.online()) throw new ContactMetricsOfflineError('QQ 暂不可在线查询');
              try {
                await job.run();
                completed.add(job.key);
              } catch (error) {
                failures.push(
                  `${job.key.split(':').at(-1)}：${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          } finally {
            if (report && !this.disposed) await this.summarizeFriend(uin, uid);
          }
          if (failures.length) throw new Error(failures.join('；'));
        },
      };
    });
  }

  private async groupFriends(code: string) {
    const buddies = new Set((await this.friends()).map((friend) => friend.uid));
    const directory = await this.services.groupInfo.listGroupDirectory();
    const expected = directory.find((row) => row.groupCode === code)?.memberCount;
    const local = await this.services.groupInfo.listExportMembers(BigInt(code));
    let members = local;
    if (
      expected === undefined ||
      expected <= 0 ||
      local.length !== expected ||
      local.some((row) => !validContactUid(row.uid))
    ) {
      if (!this.online()) throw new ContactMetricsOfflineError('群成员需要在线补齐');
      members = (
        await this.services.groupInfo.fetchOnlineMembers(Number(code), { force: true, priority: 1 })
      ).map((row) => ({ uid: row.uid, uin: String(row.uin), name: row.nickname, categoryId: 0 }));
      if (members.some((row) => !validContactUid(row.uid))) throw new Error('群成员身份未完整返回');
    }
    const ids = new Set(members.map((row) => row.uid).filter(Boolean));
    const friendCount = [...ids].filter((uid) => buddies.has(uid)).length;
    await this.cache.record(`group:${code}`, { friendCount });
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
    void (async () => {
      try {
        const maxAgeMs = range === 'older24h' ? 24 * 60 * 60 * 1000 : undefined;
        const jobs =
          target === 'groupMembers'
            ? []
            : await this.friendJobs(
                undefined,
                !missingOnly && range === 'all',
                fields,
                true,
                maxAgeMs,
              );
        const groups =
          target === 'groupMembers' ||
          !fields ||
          fields.some((field) => ['friendCount', 'activityScore'].includes(field))
            ? await this.services.groupInfo.listGroupDirectory()
            : [];
        if (target === 'groupMembers') {
          for (const group of groups)
            jobs.push({
              key: `group:${group.groupCode}`,
              label: `群成员名单（${group.groupCode}）`,
              run: async () => {
                if (!this.current() || this.disposed) throw new Error('账号已切换');
                let count: number;
                try {
                  count = await this.services.groupInfo.refreshGroupMembers(group.groupCode);
                } catch (error) {
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
          for (let offset = 0; groups.length; offset += 500) {
            const details = await this.services.groupInfo.listAllGroups(500, offset);
            for (const group of details)
              this.groupMeta.set(String(group.groupCode), {
                群名: group.groupName,
                备注: group.remark,
                人数: group.memberCount,
                群容量: group.maxMemberCount,
                创建时间: group.createTime,
              });
            if (details.length < 500) break;
          }
          if (groups.length)
            for (const group of groups) {
              if (this.stopPreparing || this.disposed) break;
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
                    try {
                      const score = this.groupMeta.get(group.groupCode)?.群活跃度;
                      if (
                        typeof score === 'number' &&
                        (!fields || fields.includes('activityScore'))
                      )
                        await this.cache.record(`group:${group.groupCode}`, {
                          activityScore: score,
                        });
                      if (!fields || fields.includes('friendCount'))
                        await this.groupFriends(group.groupCode);
                    } catch (error) {
                      if (!(error instanceof ContactMetricsOfflineError))
                        await this.cache.failed(`group:${group.groupCode}`, 'friendCount', error);
                      throw error;
                    } finally {
                      if (!this.disposed) await this.summarizeGroup(group.groupCode);
                    }
                  },
                });
            }
          for (let offset = 0; groups.length; offset += 500) {
            const ext = await this.services.groupInfo.listAllGroupsExt(500, offset);
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
        if (!this.current() || this.disposed) throw new Error('账号已切换');
        this.appendLog(`本地资料读取完成，准备 ${jobs.length} 项在线查询`);
        if (this.stopPreparing) {
          backgroundTasks.finish(id, 'cancelled');
          return;
        }
        this.cache.start(
          jobs,
          target === 'groupMembers' ? '群成员名单' : '好友在线指标',
          target === 'groupMembers'
            ? async () => {
                if (!this.current() || this.disposed) throw new Error('账号已切换');
                this.appendLog('群成员更新结束，开始重新计算群交集');
                await this.services.groupInfo.getRelationGraph({ force: true });
                if (!this.current() || this.disposed) return;
                this.relationGraphRevision++;
                this.appendLog('群交集已重新计算');
                this.cache.emit('relationGraphChanged');
              }
            : undefined,
        );
      } catch (error) {
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
        this.cache.emit('changed');
      }
    })();
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
    if (this.disposed || !this.current()) return;
    if (kind) this.pendingKinds.add(kind);
    this.checkAgain = true;
    if (!this.timer && !this.checking)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void withDatabasePriority('background', () => this.checkChanges());
      }, this.watchDelay);
  }

  private async checkChanges() {
    this.checking = true;
    this.checkAgain = false;
    const kinds = new Set(this.pendingKinds);
    this.pendingKinds.clear();
    try {
      const friends = await this.friends();
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
        const profiles = await this.services.profile.profilesByUids([
          ...new Set([...next.keys(), ...cachedLikeUids]),
        ]);
        await this.excludeLikeMetrics(profiles);
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
          const ext = await this.services.groupInfo.listAllGroupsExt(500, offset);
          if (ext.length < 500) break;
        }
      const memberSnapshot = await this.services.groupInfo.contactMembershipSnapshot([
        ...next.keys(),
      ]);
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
        if (summary?.total === group.memberCount && group.memberCount > 0)
          await this.cache.recordIfChanged(`group:${group.groupCode}`, {
            friendCount: [...ids].filter((uid) => next.has(uid)).length,
          });
      }
      this.cache.emit('baseChanged');
      await this.cache.stale(
        [...affected].flatMap((uid) => (next.has(uid) ? [`friend:${next.get(uid)}`] : [])),
        ['commonGroups', 'commonFriends'],
      );
      if (this.online())
        for (const uid of affected) {
          if (!this.current() || this.disposed) return;
          const uin = next.get(uid);
          if (uin) {
            await this.services.accountWrite.commonRelationships(uin, 1);
            const row = (await this.cache.snapshot()).rows[`friend:${uin}`];
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
      if (!this.disposed) console.warn('[contacts] 增量校准失败', error);
    } finally {
      this.checking = false;
      if (this.checkAgain) this.requestCheck();
    }
  }

  async dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const watch of this.watches) watch.unmount();
    if (this.taskId)
      backgroundTasks.finish(this.taskId, 'cancelled', { note: '账号已关闭，已保存完成的缓存' });
    if (this.taskId) backgroundTasks.setActions(this.taskId, []);
    try {
      await this.cache.dispose();
    } catch (error) {
      console.warn('[contacts] 关闭时缓存保存失败', error);
    }
  }
}

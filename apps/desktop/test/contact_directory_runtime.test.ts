import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactDirectoryRuntime } from '../src/main/context/contact_metrics';
import { GroupDirectoryTimeCache } from '../src/main/context/group_directory_times';
import { backgroundTasks } from '../src/main/background_tasks';
import { backgroundTasksRouter } from '../src/main/ipc/routers/background_tasks';
import type { AccountServices } from '../src/main/context/app_context';
import type { AccountSession } from '@weq/account';
import type { DbWatchService } from '@weq/service';
import { scheduleDatabase, type UserProfile } from '@weq/db';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup(online = true, groupReconcileInterval = 5) {
  const root = await mkdtemp(join(tmpdir(), 'weq-contact-runtime-'));
  const buddies = [{ uid: 'u_friend', uin: 12345n }];
  const profiles: Array<Partial<UserProfile> & Pick<UserProfile, 'uid' | 'uin' | 'isBot'>> = [];
  const summaries = new Map([['10001', { total: 2, friends: new Set(['u_friend']) }]]);
  const common = vi.fn(
    async (): Promise<
      Awaited<ReturnType<AccountServices['accountWrite']['commonRelationships']>>
    > => ({
      friendCount: 0,
      groups: [],
      friendError: null,
      groupError: null,
    }),
  );
  const services = {
    recentContacts: {
      getRecentContact: vi.fn(
        async (_limit: number) =>
          [] as Array<{
            chatType: string | number;
            targetUid: string;
            targetUin: bigint;
          }>,
      ),
    },
    deletedSessions: {
      listDeletedSessions: vi.fn(
        async () =>
          [] as Array<{
            chatType: number;
            targetUid: string;
            resolvable: boolean;
          }>,
      ),
    },
    profile: {
      listBuddies: vi.fn(async () => buddies),
      profilesByUids: vi.fn(async () => profiles),
    },
    accountWrite: {
      commonRelationships: common,
      friendClue: vi.fn(
        async (): Promise<{ addedAt: number | null; direction: string | null }> => ({
          addedAt: 123,
          direction: 'incoming',
        }),
      ),
    },
    peerStats: {
      getQqLevel: vi.fn(async (_uin: string, _priority?: number) => 1),
      getLikeCount: vi.fn(async (_uid: string, _priority?: number) => 0),
    },
    profileExtras: { energy: vi.fn(async () => ({})), educationHistory: vi.fn(async () => ({})) },
    intentSense: { cachedProfileSummaries: vi.fn(() => []) },
    groupInfo: {
      setMemberRosterCache: vi.fn(),
      setGroupProfileCache: vi.fn(),
      disposeGroupProfiles: vi.fn(),
      getExtendedProfile: vi.fn(async () => ({ error: null })),
      listGroupDirectory: vi.fn(async () => [{ groupCode: '10001', memberCount: 2 }]),
      listExportMembers: vi.fn(async (_groupCode?: bigint) => [
        { uid: 'u_friend' },
        { uid: 'u_other' },
      ]),
      fetchOnlineMembers: vi.fn(async () => [
        { uid: 'u_friend', uin: 12345, nickname: '合成好友' },
      ]),
      listAllGroupsExt: vi.fn(
        async (): Promise<Array<{ groupCode: bigint; activityScore: number }>> => [],
      ),
      listAllGroups: vi.fn(async () => [
        {
          groupCode: 10001n,
          groupName: '合成群',
          remark: '',
          memberCount: 2,
          maxMemberCount: 500,
          createTime: 123,
        },
      ]),
      contactMembershipSnapshot: vi.fn(async () => summaries),
    },
  };
  const session = {
    context: { uin: '99999' },
    selfUid: 'u_self',
    c2cMsgs: { directoryTimePage: vi.fn(async () => ({ items: [], done: true })) },
    groupMsgs: {
      recentDirectoryTimes: vi.fn(async () => ({})),
      directoryTimes: vi.fn(async () => ({ time: null, mine: null })),
      directoryMaxSeqs: vi.fn(async () => ({ '10001': '42' })),
    },
    profileInfo: { dbPath: '/synthetic/profile.db' },
    groupMembers: {
      dbPath: '/synthetic/groups.db',
      getMember: vi.fn(async () => ({ memberFlag: 0, joinTime: 123 })),
      selfJoinTimes: vi.fn(async () => ({ '10001': 123 })),
    },
  };
  const callbacks: Array<() => void> = [];
  const watcher = {
    mount: (input: { onDbFileChangeHook: () => void }) => {
      callbacks.push(input.onDbFileChangeHook);
      return { unmount: vi.fn() };
    },
  };
  let current = true;
  const runtime = new ContactDirectoryRuntime(
    services as unknown as AccountServices,
    session as unknown as AccountSession,
    root,
    watcher as unknown as DbWatchService,
    () => online,
    () => current,
    'synthetic',
    5,
    groupReconcileInterval,
  );
  cleanup.push(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return {
    runtime,
    services,
    callbacks,
    summaries,
    buddies,
    profiles,
    session,
    setOnline: (value: boolean) => {
      online = value;
    },
    switchAccount: () => {
      current = false;
    },
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
// 每个用例都会新建指标缓存与历史存储 worker，CI 分片并行时首次读取可能超过默认 1s。
const waitFor = (assertion: () => unknown) => vi.waitFor(assertion, { timeout: 4_000 });
it('群来源统计只读已缓存线索，区分未知来源、缺项与离群', async () => {
  const { runtime, services, buddies } = await setup(false);
  buddies.push({ uid: 'u_other', uin: 12346n });
  await runtime.cache.record('friend:12345', { source: '通过群聊', sourceGroup: '10001' });
  await expect(runtime.groupFriendSources('10001')).resolves.toEqual({
    friendUids: ['u_friend', 'u_other'],
    addedUids: ['u_friend'],
    pendingUids: ['u_other'],
    unknown: 0,
    rosterComplete: true,
  });
  await runtime.cache.record('friend:12346', { source: '通过群聊', sourceGroup: '' });
  await expect(runtime.groupFriendSources('10001')).resolves.toMatchObject({
    addedUids: ['u_friend'],
    pendingUids: [],
    unknown: 1,
  });
  await runtime.cache.project('friend:12345', { addedAt: 123 }, Date.now() + 1000);
  await expect(runtime.groupFriendSources('10001')).resolves.toMatchObject({
    addedUids: [],
    pendingUids: ['u_friend'],
    unknown: 1,
  });
  services.groupInfo.listExportMembers.mockResolvedValue([{ uid: 'u_friend' }]);
  services.groupInfo.listGroupDirectory.mockResolvedValue([{ groupCode: '10001', memberCount: 1 }]);
  await expect(runtime.groupFriendSources('10001')).resolves.toMatchObject({
    friendUids: ['u_friend'],
    unknown: 0,
    rosterComplete: true,
  });
  expect(services.accountWrite.friendClue).not.toHaveBeenCalled();
});

it('新增好友字段复用现有范围，来源单独刷新不会被添加时间缺省误判失败', async () => {
  const { runtime, services } = await setup();
  await runtime.rebuild(false, ['energy', 'schools', 'source']);
  await waitFor(() => {
    expect(runtime.cache.progress.done).toBe(1);
    expect(runtime.cache.progress.status).toBe('completed');
  });
  expect(services.profileExtras.energy).toHaveBeenCalledWith('12345', 1);
  expect(services.profileExtras.educationHistory).toHaveBeenCalledWith('12345', 1);
  expect(services.accountWrite.friendClue).toHaveBeenCalledWith('u_friend', 1);
  expect(services.groupInfo.getExtendedProfile).not.toHaveBeenCalled();
});
it('群扩展失败仍准备本人入群时间，群资料范围不触发好友查询', async () => {
  const { runtime, services } = await setup();
  services.groupInfo.getExtendedProfile.mockImplementationOnce(async () => {
    await runtime.cache.project('group:10001', { joinedAt: 123 });
    return { error: '读取失败' };
  });
  await runtime.rebuild(false, ['grade', 'freezeState', 'joinedAt']);
  await waitFor(() => {
    expect(runtime.cache.progress.done).toBe(1);
    expect(runtime.cache.progress.status).toBe('failed');
  });
  expect((await runtime.cache.row('group:10001')).joinedAt?.value).toBe(123);
  expect(services.accountWrite.friendClue).not.toHaveBeenCalled();
  expect(services.groupInfo.fetchOnlineMembers).not.toHaveBeenCalled();
});
it('只刷新本人入群时间也查询直接群资料，不为此拉全群成员', async () => {
  const { runtime, services } = await setup();
  await runtime.rebuild(false, ['joinedAt'], 'all');
  await waitFor(() =>
    expect(services.groupInfo.getExtendedProfile).toHaveBeenCalledWith(10001, true, true, 1),
  );
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.groupInfo.fetchOnlineMembers).not.toHaveBeenCalled();
});
it('本地时间、群序号、入群和画像摘要在账号切换后拒绝旧读取', async () => {
  const { runtime, services, switchAccount } = await setup();
  expect(await runtime.localTimes()).toEqual({ rows: {}, done: true });
  expect(await runtime.localJoins()).toEqual({ '10001': 123 });
  expect(await runtime.localGroupMaxSeqs()).toEqual({ '10001': '42' });
  expect(runtime.cachedProfiles()).toEqual([]);
  expect(services.intentSense.cachedProfileSummaries).toHaveBeenCalledOnce();
  switchAccount();
  await expect(runtime.localGroupTimes(['10001'])).rejects.toThrow('切换');
  await expect(runtime.localJoins()).rejects.toThrow('切换');
  await expect(runtime.localGroupMaxSeqs()).rejects.toThrow('切换');
  expect(() => runtime.cachedProfiles()).toThrow('切换');
});
it('账号关闭后在途群会话摘要不能返回给旧目录', async () => {
  const { runtime, session } = await setup();
  const wait = deferred<void>();
  session.groupMsgs.recentDirectoryTimes.mockImplementationOnce(async () => {
    await wait.promise;
    return { '10001': { time: 100 } };
  });
  const pending = runtime.localGroupTimes(['10001']);
  const rejected = expect(pending).rejects.toThrow();
  await runtime.dispose();
  wait.resolve();
  await rejected;
  expect(session.groupMsgs.directoryTimes).not.toHaveBeenCalled();
});

it('群时间先返回已核对摘要和落盘结果，并定向重查发生变化的群', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-group-time-cache-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'messages.db');
  const path = join(root, 'times.json');
  await writeFile(source, 'original');
  const gate = deferred<void>();
  const readRecent = vi.fn(async () => ({ '10001': { time: 123 } }));
  const readGroup = vi.fn(async (code: string) => {
    await gate.promise;
    return code === '10001' ? { time: 125, mine: 50 } : { time: null, mine: null };
  });
  const codes = ['10001', '10002'];
  const first = new GroupDirectoryTimeCache(
    path,
    source,
    readRecent,
    readGroup,
    new AbortController().signal,
  );
  expect(await first.read(codes)).toEqual({
    rows: { '10001': { time: 123 } },
    done: false,
    failed: [],
  });
  gate.resolve();
  await waitFor(async () => expect((await first.read(codes)).done).toBe(true));
  expect(readGroup.mock.calls).toEqual([['10001'], ['10002']]);

  readRecent.mockClear();
  readGroup.mockClear();
  const reopened = new GroupDirectoryTimeCache(
    path,
    source,
    readRecent,
    readGroup,
    new AbortController().signal,
  );
  expect((await reopened.read(codes)).rows).toEqual({
    '10001': { time: 125, mine: 50 },
    '10002': { time: null, mine: null },
  });
  await waitFor(async () => expect((await reopened.read(codes)).done).toBe(true));
  expect(readRecent).not.toHaveBeenCalled();
  expect(readGroup).not.toHaveBeenCalled();

  await writeFile(source, 'changed version');
  reopened.invalidate();
  reopened.prioritize(['10001']);
  readGroup.mockResolvedValueOnce({ time: 100, mine: 50 });
  expect((await reopened.read(codes)).rows['10001']?.time).toBe(125);
  await waitFor(async () => expect((await reopened.read(codes)).rows['10001']?.time).toBe(100));
  expect(readGroup.mock.calls).toEqual([['10001']]);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function settled(f: Awaited<ReturnType<typeof setup>>) {
  await waitFor(async () =>
    expect((await f.runtime.cache.row('group:10001')).friendCount?.value).toBe(1),
  );
  await turn();
}

it.each(['dispose', 'switch'] as const)('好友读取途中 %s 后不继续资料校准', async (mode) => {
  const f = await setup();
  await settled(f);
  const gate = deferred<typeof f.buddies>();
  f.services.profile.listBuddies.mockClear().mockImplementationOnce(() => gate.promise);
  f.services.profile.profilesByUids.mockClear();
  f.services.groupInfo.listGroupDirectory.mockClear();
  f.callbacks[0]!();
  await waitFor(() => expect(f.services.profile.listBuddies).toHaveBeenCalledOnce());
  if (mode === 'dispose') await f.runtime.dispose();
  else f.switchAccount();
  gate.resolve(f.buddies);
  await turn();
  await turn();
  expect(f.services.profile.profilesByUids).not.toHaveBeenCalled();
  expect(f.services.groupInfo.listGroupDirectory).not.toHaveBeenCalled();
});

it('群扩展整页返回前退出，不再请求后页或成员快照', async () => {
  const f = await setup();
  await settled(f);
  const gate = deferred<Array<{ groupCode: bigint; activityScore: number }>>();
  const pages = f.services.groupInfo.listAllGroupsExt;
  pages
    .mockClear()
    .mockImplementationOnce(() => gate.promise)
    .mockResolvedValue([]);
  f.services.groupInfo.contactMembershipSnapshot.mockClear();
  f.callbacks[1]!();
  await waitFor(() => expect(pages).toHaveBeenCalledOnce());
  await f.runtime.dispose();
  gate.resolve(
    Array.from({ length: 500 }, (_, index) => ({ groupCode: BigInt(index + 1), activityScore: 0 })),
  );
  await turn();
  await turn();
  expect(pages).toHaveBeenCalledOnce();
  expect(f.services.groupInfo.contactMembershipSnapshot).not.toHaveBeenCalled();
});

it('退出解除自己挂接的指标缓存与观察回调，迟到观察不再回填', async () => {
  const f = await setup();
  await settled(f);
  const services = f.services as unknown as AccountServices;
  const observe = services.groupInfo.contactMembersObserved!;
  const gate = deferred<typeof f.buddies>();
  f.services.profile.listBuddies.mockImplementationOnce(() => gate.promise);
  const record = vi.spyOn(f.runtime.cache, 'record');
  const pending = observe(10001, [{ uid: 'u_friend' }] as Parameters<typeof observe>[1]);
  await f.runtime.dispose();
  gate.resolve(f.buddies);
  await pending;
  expect(record).not.toHaveBeenCalled();
  expect(services.groupInfo.contactMembersObserved).toBeUndefined();
  expect(services.groupInfo.contactMetrics).toBeUndefined();
  expect(services.accountWrite.contactMetrics).toBeUndefined();
  expect(services.peerStats.contactMetrics).toBeUndefined();
});

it('退出不会解除之后由其他实例替换的观察回调', async () => {
  const f = await setup();
  await settled(f);
  const services = f.services as unknown as AccountServices;
  const replacement = vi.fn(async () => {});
  services.groupInfo.contactMembersObserved = replacement;
  await f.runtime.dispose();
  expect(services.groupInfo.contactMembersObserved).toBe(replacement);
});

it('校准读取仍排队时退出，会从真实数据库调度器撤销旧工作', async () => {
  const f = await setup();
  await settled(f);
  const binding = {};
  const gate = deferred<[]>();
  const blocking = scheduleDatabase('/synthetic/profile.db', () => gate.promise, binding);
  const read = vi.fn(async () => f.buddies);
  f.services.profile.listBuddies
    .mockClear()
    .mockImplementationOnce(() => scheduleDatabase('/synthetic/profile.db', read, binding));
  try {
    f.callbacks[0]!();
    await waitFor(() => expect(f.services.profile.listBuddies).toHaveBeenCalledOnce());
    await f.runtime.dispose();
    gate.resolve([]);
    await blocking;
    await turn();
    await turn();
    expect(read).not.toHaveBeenCalled();
  } finally {
    gate.resolve([]);
    await blocking;
  }
});

it('手动准备整页读取途中关闭账号，不续页或恢复旧重试动作', async () => {
  const f = await setup();
  await settled(f);
  type Details = Awaited<ReturnType<typeof f.services.groupInfo.listAllGroups>>;
  const gate = deferred<Details>();
  const pages = f.services.groupInfo.listAllGroups;
  pages
    .mockClear()
    .mockImplementationOnce(() => gate.promise)
    .mockResolvedValue([]);
  f.services.groupInfo.listAllGroupsExt.mockClear();
  const id = await f.runtime.rebuild(false, ['friendCount']);
  await waitFor(() => expect(pages).toHaveBeenCalledOnce());
  await f.runtime.dispose();
  gate.resolve(
    Array.from({ length: 500 }, (_, index) => ({
      groupCode: BigInt(index + 1),
      groupName: '合成群',
      remark: '',
      memberCount: 2,
      maxMemberCount: 500,
      createTime: 123,
    })),
  );
  await turn();
  await turn();
  const task = backgroundTasks.snapshot().find((task) => task.id === id);
  expect(task?.status).toBe('cancelled');
  expect(task?.actions).toEqual([]);
  expect(pages).toHaveBeenCalledOnce();
  expect(f.services.groupInfo.listAllGroupsExt).not.toHaveBeenCalled();
});

it('账号关闭后，同一好友已入队但未发出的在线字段不再执行', async () => {
  const f = await setup();
  await settled(f);
  const gate = deferred<number>();
  const started = Promise.withResolvers<void>();
  const fetchLikes = vi.fn(async () => 0);
  f.services.peerStats.getQqLevel.mockImplementationOnce(() =>
    f.runtime.cache.schedule('friend:12345:level', () => {
      started.resolve();
      return gate.promise;
    }),
  );
  f.services.peerStats.getLikeCount.mockImplementationOnce(() =>
    f.runtime.cache.schedule('friend:u_friend:likes', fetchLikes),
  );
  await f.runtime.rebuild(false, ['level', 'likeCount']);
  await started.promise;
  expect(f.services.peerStats.getLikeCount).toHaveBeenCalled();
  await f.runtime.dispose();
  gate.resolve(1);
  await turn();
  await turn();
  expect(fetchLikes).not.toHaveBeenCalled();
});
it('缓存更新覆盖非好友和临时会话但不查线索，群聊只更新当前群目录', async () => {
  const { runtime, services, profiles } = await setup();
  await waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
  services.recentContacts.getRecentContact.mockResolvedValue([
    { chatType: 1, targetUid: 'u_friend', targetUin: 12345n },
    { chatType: 1, targetUid: 'u_former', targetUin: 23456n },
    { chatType: 'KCHATTYPETEMPC2CFROMGROUP', targetUid: 'u_temp', targetUin: 0n },
    { chatType: 99, targetUid: 'u_uid_only', targetUin: 0n },
    { chatType: 2, targetUid: '20002', targetUin: 0n },
    { chatType: 8, targetUid: 'device', targetUin: 0n },
    { chatType: 1, targetUid: 'u_self', targetUin: 99999n },
  ]);
  services.deletedSessions.listDeletedSessions.mockResolvedValue([
    { chatType: 1, targetUid: 'u_deleted', resolvable: true },
    { chatType: 2, targetUid: '40004', resolvable: true },
    { chatType: 1, targetUid: 'u_invalid', resolvable: false },
  ]);
  profiles.push(
    { uid: 'u_temp', uin: 34567n, isBot: false },
    { uid: 'u_deleted', uin: 45678n, isBot: false },
  );
  services.groupInfo.listAllGroups.mockResolvedValue([
    {
      groupCode: 30003n,
      groupName: '已退出群',
      remark: '',
      memberCount: 2,
      maxMemberCount: 500,
      createTime: 123,
    },
  ]);
  services.groupInfo.fetchOnlineMembers.mockResolvedValue([
    { uid: 'u_former', uin: 23456, nickname: '非好友' },
    { uid: 'u_friend', uin: 12345, nickname: '好友' },
  ]);
  await runtime.rebuild();
  await waitFor(() => expect(runtime.cache.progress.total).toBe(7));
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.recentContacts.getRecentContact).toHaveBeenCalledWith(-1);
  expect(services.peerStats.getQqLevel.mock.calls.map(([uin]) => uin).sort()).toEqual([
    '12345',
    '23456',
    '34567',
    '45678',
  ]);
  expect(services.peerStats.getLikeCount.mock.calls.map(([uid]) => uid).sort()).toEqual([
    'u_deleted',
    'u_former',
    'u_friend',
    'u_temp',
    'u_uid_only',
  ]);
  expect(
    services.groupInfo.listExportMembers.mock.calls.map(([code]) => String(code)).sort(),
  ).toEqual(['10001']);
  expect(services.accountWrite.friendClue).toHaveBeenCalledTimes(1);
  expect(services.accountWrite.friendClue).toHaveBeenCalledWith('u_friend', 1);
  expect((await runtime.cache.row('group:20002')).friendCount).toBeUndefined();
  expect((await runtime.cache.row('friend:u_uid_only')).level?.state).toBe('failed');
});

it('当前群目录为空时不获取历史群，保留已有本地指标供分组排序使用', async () => {
  const { runtime, services } = await setup();
  await waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
  services.groupInfo.listGroupDirectory.mockResolvedValue([]);
  services.groupInfo.listAllGroups.mockResolvedValue([]);
  services.recentContacts.getRecentContact.mockResolvedValue([
    { chatType: 2, targetUid: '20002', targetUin: 0n },
    { chatType: 2, targetUid: '30003', targetUin: 0n },
  ]);
  services.groupInfo.fetchOnlineMembers.mockRejectedValueOnce(new Error('合成退群查询失败'));
  await runtime.cache.record('group:20002', { friendCount: 8 });
  const id = await runtime.rebuild(false, ['friendCount']);
  await waitFor(() =>
    expect(backgroundTasks.snapshot().find((task) => task.id === id)?.status).toBe('completed'),
  );
  await waitFor(() => expect(runtime.cache.progress.total).toBe(0));
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.groupInfo.listExportMembers).not.toHaveBeenCalled();
  expect(services.groupInfo.fetchOnlineMembers).not.toHaveBeenCalled();
  expect((await runtime.cache.row('group:20002')).friendCount).toMatchObject({
    value: 8,
    state: 'ready',
  });
  expect((await runtime.cache.row('group:30003')).friendCount).toBeUndefined();
});

it('慢字段不阻塞同一好友的其余指标，部分成功不判整个对象失败', async () => {
  const { runtime, services } = await setup();
  const level = Promise.withResolvers<number>();
  services.peerStats.getQqLevel.mockReturnValue(level.promise);
  services.accountWrite.friendClue.mockResolvedValue({ addedAt: 123, direction: null });
  services.accountWrite.commonRelationships.mockResolvedValue({
    friendCount: 0,
    groups: null,
    friendError: null,
    groupError: '合成共同群失败',
  });
  const id = await runtime.rebuild();
  await waitFor(() =>
    expect(services.accountWrite.commonRelationships).toHaveBeenCalledWith('12345', 1),
  );
  expect(runtime.cache.progress.lanes?.friends.done).toBe(0);
  level.reject(new Error('合成等级获取失败'));
  await waitFor(() => expect(runtime.cache.progress.done).toBe(3));
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.peerStats.getLikeCount).toHaveBeenCalledWith('u_friend', 1);
  expect(backgroundTasks.snapshot().find((task) => task.id === id)?.logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('部分字段未取得') }),
    ]),
  );
});

it('多个好友卡在慢字段时，队列继续刷新后面的好友', async () => {
  const f = await setup();
  await settled(f);
  f.buddies.push(
    { uid: 'u_second', uin: 23456n },
    { uid: 'u_third', uin: 34567n },
    { uid: 'u_fourth', uin: 45678n },
    { uid: 'u_fifth', uin: 56789n },
  );
  const slow = deferred<number>();
  for (let index = 0; index < 3; index++)
    f.services.peerStats.getQqLevel.mockReturnValueOnce(slow.promise);
  await f.runtime.rebuild(false, ['level']);
  await waitFor(() => expect(f.runtime.cache.progress.lanes?.friends.done).toBe(2));
  expect(f.services.peerStats.getQqLevel.mock.calls.map(([uin]) => uin)).toEqual([
    '12345',
    '23456',
    '34567',
    '45678',
    '56789',
  ]);
  expect(f.runtime.cache.progress.status).toBe('running');
  slow.resolve(1);
  await waitFor(() => expect(f.runtime.cache.progress.status).toBe('completed'));
  expect(f.runtime.cache.progress.lanes?.friends).toEqual({ done: 5, total: 5, failed: 0 });
});

it('好友并行刷新中断线，继续时保留同批已成功的字段', async () => {
  const { runtime, services, setOnline } = await setup();
  const level = Promise.withResolvers<number>();
  services.peerStats.getQqLevel.mockReturnValueOnce(level.promise);
  await runtime.rebuild(false, ['level', 'likeCount']);
  await waitFor(() => expect(services.peerStats.getLikeCount).toHaveBeenCalledTimes(1));
  setOnline(false);
  level.reject(new Error('连接中断'));
  await waitFor(() => expect(runtime.cache.progress.status).toBe('paused'));
  setOnline(true);
  runtime.cache.resume();
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.peerStats.getQqLevel).toHaveBeenCalledTimes(2);
  expect(services.peerStats.getLikeCount).toHaveBeenCalledTimes(1);
});

it('全部请求均失败时仍如实标记失败，保留旧值', async () => {
  const { runtime, services } = await setup();
  await runtime.cache.record('friend:12345', { level: 8 });
  services.peerStats.getQqLevel.mockRejectedValue(new Error('合成失败'));
  await runtime.rebuild(false, ['level']);
  await waitFor(() => expect(runtime.cache.progress.status).toBe('failed'));
  expect((await runtime.cache.row('friend:12345')).level?.value).toBe(8);
});

it('群内好友数失败不抹去已取得的本地群活跃度', async () => {
  const { runtime, services } = await setup();
  await waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
  services.groupInfo.listAllGroupsExt.mockResolvedValue([{ groupCode: 10001n, activityScore: 80 }]);
  services.groupInfo.listExportMembers.mockResolvedValue([]);
  services.groupInfo.fetchOnlineMembers.mockRejectedValue(new Error('合成成员获取失败'));
  await runtime.rebuild(false, ['activityScore', 'friendCount']);
  await waitFor(() => expect(runtime.cache.progress.done).toBe(1));
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(await runtime.cache.row('group:10001')).toMatchObject({
    activityScore: { value: 80, state: 'ready' },
    friendCount: { state: 'failed' },
  });
});

it('只请求共同群时不因无关共同好友失败而失败', async () => {
  const { runtime, services } = await setup();
  services.accountWrite.commonRelationships.mockResolvedValue({
    friendCount: null,
    friendError: '合成共同好友失败',
    groups: [],
    groupError: null,
  });
  await runtime.rebuild(false, ['commonGroups']);
  await waitFor(() => expect(runtime.cache.progress.done).toBe(1));
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
});

it.each([
  { missingOnly: false, range: 'older24h' as const },
  { missingOnly: true, range: 'all' as const },
])('历史联系人同样遵循逐项更新范围 $range / 补齐 $missingOnly', async ({ missingOnly, range }) => {
  const { runtime, services } = await setup();
  await waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
  services.recentContacts.getRecentContact.mockResolvedValue([
    { chatType: 1, targetUid: 'u_former', targetUin: 23456n },
    { chatType: 100, targetUid: 'u_temp', targetUin: 34567n },
  ]);
  if (!missingOnly) {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 25 * 60 * 60 * 1000);
    try {
      await runtime.cache.record('friend:23456', { level: 1 });
    } finally {
      clock.mockRestore();
    }
  }
  await runtime.cache.record('friend:12345', { level: 2 });
  await runtime.cache.record('friend:34567', { level: 3 });
  await runtime.rebuild(missingOnly, ['level'], range);
  await waitFor(() => expect(services.peerStats.getQqLevel).toHaveBeenCalled());
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.peerStats.getQqLevel.mock.calls.map(([uin]) => uin)).toEqual(['23456']);
});

it('批量更新跳过机器人与企业账号获赞，删除旧值且不生成失败或零值', async () => {
  const { runtime, services, buddies, profiles } = await setup();
  await waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
  buddies.push({ uid: 'u_bot', uin: 3889001776n }, { uid: 'u_enterprise', uin: 3000123456n });
  profiles.push(
    { uid: 'u_friend', uin: 12345n, isBot: false },
    { uid: 'u_bot', uin: 3889001776n, isBot: true },
    {
      uid: 'u_enterprise',
      uin: 3000123456n,
      isBot: false,
      extInfo: { isEnterprise: true, interactMarks: [], privileges: [], interests: [], album: [] },
    },
  );
  await runtime.cache.record('friend:u_bot', { likeCount: 0 });
  await runtime.cache.record('friend:3000123456', { likeCount: 3 });
  await runtime.rebuild(false, ['likeCount']);
  await waitFor(() => expect(services.peerStats.getLikeCount).toHaveBeenCalled());
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.peerStats.getLikeCount).toHaveBeenCalledTimes(1);
  expect(services.peerStats.getLikeCount).toHaveBeenCalledWith('u_friend', 1);
  const { rows } = await runtime.snapshot();
  expect(rows['friend:u_bot']?.likeCount).toBeUndefined();
  expect(rows['friend:3000123456']?.likeCount).toBeUndefined();
  expect(runtime.cache.progress.total).toBe(1);
});

it('资料校准也清理非好友企业用户的历史获赞，不等待手动刷新', async () => {
  const { runtime, services, profiles, callbacks } = await setup();
  await waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
  profiles.push({
    uid: 'u_former_enterprise',
    uin: 3000234567n,
    isBot: false,
    extInfo: { isEnterprise: true, interactMarks: [], privileges: [], interests: [], album: [] },
  });
  await runtime.cache.record('friend:u_former_enterprise', { likeCount: 0 });
  callbacks[0]!();
  await waitFor(async () =>
    expect((await runtime.cache.row('friend:u_former_enterprise')).likeCount).toBeUndefined(),
  );
  expect(services.profile.profilesByUids).toHaveBeenCalledWith(
    expect.arrayContaining(['u_former_enterprise']),
  );
  expect(services.peerStats.getLikeCount).not.toHaveBeenCalled();
});
it('重建只有一个任务；离线仍完成本地群好友统计，在线阶段可暂停', async () => {
  const { runtime, services } = await setup(false);
  const first = await runtime.rebuild(),
    second = await runtime.rebuild();
  expect(first).toBe(second);
  await waitFor(() => expect(runtime.cache.progress.status).toBe('paused'));
  expect((await runtime.snapshot()).rows['group:10001']?.friendCount?.value).toBe(1);
  expect(services.peerStats.getQqLevel).not.toHaveBeenCalled();
  expect(backgroundTasks.snapshot().find((task) => task.id === first)?.status).toBe('paused');
});
it('普通群资料变化不在线重查；好友成员变化才定向查询共同关系', async () => {
  const { runtime, services, callbacks, summaries } = await setup();
  await waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
  callbacks[1]!();
  await waitFor(() =>
    expect(services.groupInfo.contactMembershipSnapshot.mock.calls.length).toBeGreaterThan(1),
  );
  expect(services.accountWrite.commonRelationships).not.toHaveBeenCalled();
  summaries.set('10001', { total: 1, friends: new Set() });
  callbacks[1]!();
  await waitFor(() =>
    expect(services.accountWrite.commonRelationships).toHaveBeenCalledWith('12345', 1),
  );
  expect(services.accountWrite.commonRelationships).toHaveBeenCalledTimes(1);
  await runtime.dispose();
});

it('群文件连续变化合并全群校准，资料刷新和名册变更仍可先完成', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  try {
    const f = await setup(false, 30_000);
    await settled(f);
    const groups = f.services.groupInfo.contactMembershipSnapshot;
    const profiles = f.services.profile.profilesByUids;
    const roster = f.services.profile.listBuddies;
    expect(groups).toHaveBeenCalledOnce();
    expect(roster).toHaveBeenCalledOnce();
    profiles.mockClear();
    for (let i = 0; i < 10; i++) f.callbacks[1]!();
    f.callbacks[0]!();
    await waitFor(() => expect(profiles).toHaveBeenCalledOnce());
    expect(groups).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    await waitFor(() => expect(groups).toHaveBeenCalledTimes(2));
    expect(roster).toHaveBeenCalledTimes(2);
    f.callbacks[1]!();
    f.buddies.push({ uid: 'u_added', uin: 12346n });
    f.callbacks[0]!();
    await waitFor(() => expect(groups).toHaveBeenCalledTimes(3));
    expect(groups).toHaveBeenLastCalledWith(['u_friend', 'u_added'], ['10001']);
    await f.runtime.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it('群成员不完整时不写入部分计数，而是通过在线接口补齐', async () => {
  const { runtime, services } = await setup();
  services.groupInfo.listExportMembers.mockResolvedValue([{ uid: 'u_other' }]);
  await runtime.rebuild(false, ['friendCount']);
  await waitFor(() => expect(services.groupInfo.fetchOnlineMembers).toHaveBeenCalled());
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.groupInfo.fetchOnlineMembers).toHaveBeenCalled();
  expect((await runtime.snapshot()).rows['group:10001']?.friendCount?.value).toBe(1);
});
it('账号切换后旧任务的继续动作不能操作新账号', async () => {
  const { runtime, switchAccount } = await setup(false);
  const task = await runtime.rebuild();
  await waitFor(() => expect(runtime.cache.progress.status).toBe('paused'));
  switchAccount();
  await expect(backgroundTasks.act(task!, 'resume')).rejects.toThrow('原账号');
});

it('群聊失败明细独立于最近 200 条过程日志，重试成功后清除', async () => {
  const { runtime, services } = await setup();
  const group = Promise.withResolvers<{ error: null }>();
  services.groupInfo.getExtendedProfile.mockReturnValueOnce(group.promise);
  let release!: (value: {
    friendCount: number;
    groups: never[];
    friendError: null;
    groupError: null;
  }) => void;
  services.accountWrite.commonRelationships.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const id = (await runtime.rebuild(false, ['commonGroups', 'grade']))!;
  await waitFor(() => expect(release).toBeDefined());
  const running = backgroundTasks.snapshot().find((task) => task.id === id)!;
  expect(running.status).toBe('running');
  expect(running.progress).toBe(0);
  expect(running.logs?.some((line) => line.text.includes('开始'))).toBe(true);
  group.reject(new Error('合成扩展资料读取失败'));
  await waitFor(() => expect(runtime.cache.progress.lanes?.groups.failed).toBe(1));
  for (let index = 0; index < 250; index++) runtime.cache.emit('log', `合成任务日志 ${index}`);
  const task = backgroundTasks.snapshot().find((item) => item.id === id)!;
  expect(task.logs).toHaveLength(200);
  expect(task.logs?.some((line) => line.level === 'error')).toBe(false);
  const caller = backgroundTasksRouter.createCaller({});
  const input = { id, scope: task.scope!, lane: 'groups' as const };
  expect(await caller.contactFailures(input)).toEqual([
    { lane: 'groups', label: '合成群（10001） · 群扩展资料', error: '合成扩展资料读取失败' },
  ]);
  expect(await caller.contactFailures({ ...input, lane: 'friends' })).toEqual([]);
  await expect(caller.contactFailures({ ...input, scope: null })).rejects.toThrow('失效');
  release({ friendCount: 0, groups: [], friendError: null, groupError: null });
  await waitFor(() => expect(runtime.cache.progress.status).toBe('failed'));
  const failed = backgroundTasks.snapshot().find((item) => item.id === id)!;
  expect(failed.progress).toBe(100);
  expect(failed.logs?.at(-1)?.text).toContain('本轮结束');
  expect(
    failed.details?.some((line) => line.startsWith('好友获取结果：') && line.includes('12345')),
  ).toBe(true);
  expect(failed.subtasks?.find((lane) => lane.label === '好友')).toMatchObject({
    done: 1,
    total: 1,
  });
  await backgroundTasks.act(id, 'retry');
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(await caller.contactFailures(input)).toEqual([]);
  expect(services.accountWrite.commonRelationships).toHaveBeenCalledOnce();
});

it('超 24h 范围逐个好友判断，只更新超时对象，不由全局最近刷新时间决定', async () => {
  const { runtime, services, buddies } = await setup();
  await waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
  buddies.push({ uid: 'u_fresh', uin: 23456n });
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 25 * 60 * 60 * 1000);
  await runtime.cache.record('friend:12345', { level: 1 });
  clock.mockRestore();
  await runtime.cache.record('friend:23456', { level: 2 });
  await runtime.rebuild(false, ['level'], 'older24h');
  await waitFor(() => expect(services.peerStats.getQqLevel).toHaveBeenCalled());
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.peerStats.getQqLevel.mock.calls.map((call) => call[0])).toEqual(['12345']);
});

it('超 24h 范围逐个群判断，不重新读取另一个刚更新的群成员', async () => {
  const { runtime, services } = await setup();
  await waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
  services.groupInfo.listGroupDirectory.mockResolvedValue([
    { groupCode: '10001', memberCount: 2 },
    { groupCode: '20002', memberCount: 2 },
  ]);
  const now = Date.now(),
    clock = vi.spyOn(Date, 'now').mockReturnValue(now - 25 * 60 * 60 * 1000);
  await runtime.cache.record('group:10001', { friendCount: 1 });
  clock.mockRestore();
  await runtime.cache.record('group:20002', { friendCount: 1 });
  await runtime.rebuild(false, ['friendCount'], 'older24h');
  await waitFor(() => expect(services.groupInfo.listExportMembers).toHaveBeenCalled());
  await waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.groupInfo.listExportMembers.mock.calls.map((call) => String(call[0]))).toEqual([
    '10001',
  ]);
});

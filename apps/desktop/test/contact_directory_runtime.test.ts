import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactDirectoryRuntime } from '../src/main/context/contact_metrics';
import { backgroundTasks } from '../src/main/background_tasks';
import type { AccountServices } from '../src/main/context/app_context';
import type { AccountSession } from '@weq/account';
import type { DbWatchService } from '@weq/service';
import type { UserProfile } from '@weq/db';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup(online = true) {
  const root = await mkdtemp(join(tmpdir(), 'weq-contact-runtime-'));
  const buddies = [{ uid: 'u_friend', uin: 12345n }];
  const profiles: Array<Partial<UserProfile> & Pick<UserProfile, 'uid' | 'uin' | 'isBot'>> = [];
  const summaries = new Map([['10001', { total: 2, friends: new Set(['u_friend']) }]]);
  const common = vi.fn(async () => ({
    friendCount: 0,
    groups: [],
    friendError: null,
    groupError: null,
  }));
  const services = {
    profile: {
      listBuddies: vi.fn(async () => buddies),
      profilesByUids: vi.fn(async () => profiles),
    },
    accountWrite: {
      commonRelationships: common,
      friendClue: vi.fn(async () => ({ addedAt: 123, direction: 'incoming' })),
    },
    peerStats: {
      getQqLevel: vi.fn(async (_uin: string, _priority?: number) => 1),
      getLikeCount: vi.fn(async (_uid: string, _priority?: number) => 0),
    },
    groupInfo: {
      setMemberRosterCache: vi.fn(),
      listGroupDirectory: vi.fn(async () => [{ groupCode: '10001', memberCount: 2 }]),
      listExportMembers: vi.fn(async (_groupCode?: bigint) => [
        { uid: 'u_friend' },
        { uid: 'u_other' },
      ]),
      fetchOnlineMembers: vi.fn(async () => [
        { uid: 'u_friend', uin: 12345, nickname: '合成好友' },
      ]),
      listAllGroupsExt: vi.fn(async () => []),
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
    profileInfo: { dbPath: '/synthetic/profile.db' },
    groupMembers: { dbPath: '/synthetic/groups.db' },
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
    switchAccount: () => {
      current = false;
    },
  };
}
it('批量更新跳过机器人与企业账号获赞，删除旧值且不生成失败或零值', async () => {
  const { runtime, services, buddies, profiles } = await setup();
  await vi.waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
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
  await vi.waitFor(() => expect(services.peerStats.getLikeCount).toHaveBeenCalled());
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.peerStats.getLikeCount).toHaveBeenCalledTimes(1);
  expect(services.peerStats.getLikeCount).toHaveBeenCalledWith('u_friend', 1);
  const { rows } = await runtime.snapshot();
  expect(rows['friend:u_bot']?.likeCount).toBeUndefined();
  expect(rows['friend:3000123456']?.likeCount).toBeUndefined();
  expect(runtime.cache.progress.total).toBe(1);
});

it('资料校准也清理非好友企业用户的历史获赞，不等待手动刷新', async () => {
  const { runtime, services, profiles, callbacks } = await setup();
  await vi.waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
  profiles.push({
    uid: 'u_former_enterprise',
    uin: 3000234567n,
    isBot: false,
    extInfo: { isEnterprise: true, interactMarks: [], privileges: [], interests: [], album: [] },
  });
  await runtime.cache.record('friend:u_former_enterprise', { likeCount: 0 });
  callbacks[0]!();
  await vi.waitFor(async () =>
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
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('paused'));
  expect((await runtime.snapshot()).rows['group:10001']?.friendCount?.value).toBe(1);
  expect(services.peerStats.getQqLevel).not.toHaveBeenCalled();
  expect(backgroundTasks.snapshot().find((task) => task.id === first)?.status).toBe('paused');
});
it('普通群资料变化不在线重查；好友成员变化才定向查询共同关系', async () => {
  const { runtime, services, callbacks, summaries } = await setup();
  await vi.waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
  callbacks[1]!();
  await vi.waitFor(() =>
    expect(services.groupInfo.contactMembershipSnapshot.mock.calls.length).toBeGreaterThan(1),
  );
  expect(services.accountWrite.commonRelationships).not.toHaveBeenCalled();
  summaries.set('10001', { total: 1, friends: new Set() });
  callbacks[1]!();
  await vi.waitFor(() =>
    expect(services.accountWrite.commonRelationships).toHaveBeenCalledWith('12345', 1),
  );
  expect(services.accountWrite.commonRelationships).toHaveBeenCalledTimes(1);
  await runtime.dispose();
});
it('群成员不完整时不写入部分计数，而是通过在线接口补齐', async () => {
  const { runtime, services } = await setup();
  services.groupInfo.listExportMembers.mockResolvedValue([{ uid: 'u_other' }]);
  await runtime.rebuild(false, ['friendCount']);
  await vi.waitFor(() => expect(services.groupInfo.fetchOnlineMembers).toHaveBeenCalled());
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.groupInfo.fetchOnlineMembers).toHaveBeenCalled();
  expect((await runtime.snapshot()).rows['group:10001']?.friendCount?.value).toBe(1);
});
it('账号切换后旧任务的继续动作不能操作新账号', async () => {
  const { runtime, switchAccount } = await setup(false);
  const task = await runtime.rebuild();
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('paused'));
  switchAccount();
  await expect(backgroundTasks.act(task!, 'retry')).rejects.toThrow('原账号');
});

it('任务有真实进度与完整阶段日志，日志仅保留最近 200 条', async () => {
  const { runtime, services } = await setup();
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
  const id = await runtime.rebuild(false, ['commonGroups']);
  await vi.waitFor(() => expect(release).toBeDefined());
  const running = backgroundTasks.snapshot().find((task) => task.id === id)!;
  expect(running.status).toBe('running');
  expect(running.progress).toBe(0);
  expect(running.logs?.some((line) => line.text.includes('开始'))).toBe(true);
  for (let index = 0; index < 250; index++) runtime.cache.emit('log', `合成任务日志 ${index}`);
  expect(backgroundTasks.snapshot().find((task) => task.id === id)?.logs).toHaveLength(200);
  release({ friendCount: 0, groups: [], friendError: null, groupError: null });
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  const completed = backgroundTasks.snapshot().find((task) => task.id === id)!;
  expect(completed.progress).toBe(100);
  expect(completed.logs?.at(-1)?.text).toContain('本轮结束');
  expect(
    completed.details?.some((line) => line.startsWith('好友获取结果：') && line.includes('12345')),
  ).toBe(true);
  expect(completed.subtasks?.find((lane) => lane.label === '好友')).toMatchObject({
    done: 1,
    total: 1,
  });
});

it('超 24h 范围逐个好友判断，只更新超时对象，不由全局最近刷新时间决定', async () => {
  const { runtime, services, buddies } = await setup();
  await vi.waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
  buddies.push({ uid: 'u_fresh', uin: 23456n });
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 25 * 60 * 60 * 1000);
  await runtime.cache.record('friend:12345', { level: 1 });
  clock.mockRestore();
  await runtime.cache.record('friend:23456', { level: 2 });
  await runtime.rebuild(false, ['level'], 'older24h');
  await vi.waitFor(() => expect(services.peerStats.getQqLevel).toHaveBeenCalled());
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.peerStats.getQqLevel.mock.calls.map((call) => call[0])).toEqual(['12345']);
});

it('超 24h 范围逐个群判断，不重新读取另一个刚更新的群成员', async () => {
  const { runtime, services } = await setup();
  await vi.waitFor(() => expect(services.groupInfo.contactMembershipSnapshot).toHaveBeenCalled());
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
  await vi.waitFor(() => expect(services.groupInfo.listExportMembers).toHaveBeenCalled());
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.groupInfo.listExportMembers.mock.calls.map((call) => String(call[0]))).toEqual([
    '10001',
  ]);
});

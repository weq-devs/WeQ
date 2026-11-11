import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { DbWatchService } from '@weq/service';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountServices } from '../src/main/context/app_context';
import { ContactDirectoryRuntime } from '../src/main/context/contact_metrics';
import { backgroundTasks } from '../src/main/background_tasks';
import { createContactMetricsRouter } from '../src/main/ipc/routers/contact_metrics';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'weq-member-refresh-'));
  let online = true;
  const services = {
    profile: { listBuddies: vi.fn(async () => []), profilesByUids: vi.fn() },
    accountWrite: { commonRelationships: vi.fn() },
    peerStats: { getQqLevel: vi.fn(), getLikeCount: vi.fn() },
    groupInfo: {
      setMemberRosterCache: vi.fn(),
      setGroupProfileCache: vi.fn(),
      disposeGroupProfiles: vi.fn(),
      listGroupDirectory: vi.fn(async () => [
        { groupCode: '10001', memberCount: 2 },
        { groupCode: '20002', memberCount: 2 },
      ]),
      refreshGroupMembers: vi.fn(async (_code: string) => 2),
      getRelationGraph: vi.fn(async () => ({})),
      listExportMembers: vi.fn(),
      listAllGroups: vi.fn(),
      listAllGroupsExt: vi.fn(),
    },
  };
  const runtime = new ContactDirectoryRuntime(
    services as unknown as AccountServices,
    {
      context: { uin: '99999' },
      profileInfo: { dbPath: '/synthetic/profile.db' },
      groupMembers: { dbPath: '/synthetic/groups.db' },
    } as unknown as AccountSession,
    root,
    { mount: () => ({ unmount() {} }) } as unknown as DbWatchService,
    () => online,
    () => true,
    'synthetic',
    60_000,
  );
  await Promise.resolve();
  services.profile.listBuddies.mockClear();
  cleanup.push(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { runtime, services, setOnline: (value: boolean) => (online = value) };
}

it('群成员刷新通过联系人路由启动同一任务，只更新全部群名单，结束后重算一次', async () => {
  const { runtime, services } = await setup();
  const changed = vi.fn();
  runtime.cache.on('relationGraphChanged', changed);
  const caller = createContactMetricsRouter(() => runtime).createCaller({});
  const input = {
    expectedAccountUin: '99999',
    expectedAccountConfigId: 'synthetic',
    target: 'groupMembers' as const,
  };
  const notify = vi.fn();
  const subscription = (await caller.changed(input)).subscribe({ next: notify });
  cleanup.push(async () => subscription.unsubscribe());
  const id = await caller.rebuild(input);
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.groupInfo.refreshGroupMembers.mock.calls).toEqual([['10001'], ['20002']]);
  expect(services.groupInfo.getRelationGraph).toHaveBeenCalledTimes(1);
  expect(services.groupInfo.getRelationGraph).toHaveBeenCalledWith({ force: true });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith({ base: false, relationGraph: true });
  expect(services.groupInfo.listExportMembers).not.toHaveBeenCalled();
  expect(services.groupInfo.listAllGroups).not.toHaveBeenCalled();
  expect(services.groupInfo.listAllGroupsExt).not.toHaveBeenCalled();
  expect(services.profile.listBuddies).not.toHaveBeenCalled();
  expect(services.profile.profilesByUids).not.toHaveBeenCalled();
  expect(services.accountWrite.commonRelationships).not.toHaveBeenCalled();
  expect(backgroundTasks.snapshot().find((task) => task.id === id)).toMatchObject({
    status: 'completed',
    progress: 100,
    name: '更新全部群成员并重算群交集',
  });
});

it('个别群失败继续更新其余群并重算，任务可只重试失败群', async () => {
  const { runtime, services } = await setup();
  services.groupInfo.refreshGroupMembers.mockRejectedValueOnce(new Error('合成网络错误'));
  const id = await runtime.rebuild(false, undefined, 'all', 'groupMembers');
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('failed'));
  expect(services.groupInfo.refreshGroupMembers).toHaveBeenCalledTimes(2);
  expect(services.groupInfo.getRelationGraph).toHaveBeenCalledTimes(1);
  await backgroundTasks.act(id!, 'retry');
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.groupInfo.refreshGroupMembers.mock.calls).toEqual([
    ['10001'],
    ['20002'],
    ['10001'],
  ]);
  expect(services.groupInfo.getRelationGraph).toHaveBeenCalledTimes(2);
});

it('离线沿用任务暂停和继续，不以本地名单假冒在线更新，也不误复用另一范围任务', async () => {
  const { runtime, services, setOnline } = await setup();
  setOnline(false);
  const id = await runtime.rebuild(false, undefined, 'all', 'groupMembers');
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('paused'));
  expect(services.groupInfo.refreshGroupMembers).not.toHaveBeenCalled();
  expect(services.groupInfo.getRelationGraph).not.toHaveBeenCalled();
  expect(await runtime.rebuild(false, undefined, 'all', 'groupMembers')).toBe(id);
  await expect(runtime.rebuild()).rejects.toThrow('另一范围');
  setOnline(true);
  await backgroundTasks.act(id!, 'retry');
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.groupInfo.refreshGroupMembers).toHaveBeenCalledTimes(2);
});

it('取消后不再启动下一个群，继续仍复用原任务并在最后重算', async () => {
  const { runtime, services } = await setup();
  let release!: () => void;
  services.groupInfo.refreshGroupMembers.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(2);
      }),
  );
  const id = await runtime.rebuild(false, undefined, 'all', 'groupMembers');
  await vi.waitFor(() => expect(release).toBeDefined());
  await backgroundTasks.act(id!, 'stop');
  release();
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('cancelled'));
  expect(services.groupInfo.refreshGroupMembers.mock.calls).toEqual([['10001']]);
  expect(services.groupInfo.getRelationGraph).not.toHaveBeenCalled();
  await backgroundTasks.act(id!, 'retry');
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.groupInfo.refreshGroupMembers.mock.calls).toEqual([['10001'], ['20002']]);
  expect(services.groupInfo.getRelationGraph).toHaveBeenCalledTimes(1);
});

it('重算失败不标为完成，重试只重算而不重复拉取已成功名单', async () => {
  const { runtime, services } = await setup();
  services.groupInfo.getRelationGraph.mockRejectedValueOnce(new Error('合成重算失败'));
  const id = await runtime.rebuild(false, undefined, 'all', 'groupMembers');
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('failed'));
  expect(backgroundTasks.snapshot().find((task) => task.id === id)?.statusLabel).toBe('部分完成');
  expect(runtime.status().relationGraphRevision).toBe(0);
  await backgroundTasks.act(id!, 'retry');
  await vi.waitFor(() => expect(runtime.cache.progress.status).toBe('completed'));
  expect(services.groupInfo.refreshGroupMembers).toHaveBeenCalledTimes(2);
  expect(services.groupInfo.getRelationGraph).toHaveBeenCalledTimes(2);
  expect(runtime.status().relationGraphRevision).toBe(1);
});

it('成员读取达到100%仍等待计算，轻量状态在计算成功后才发布新版本和完成状态', async () => {
  const { runtime, services } = await setup();
  let release!: () => void;
  services.groupInfo.getRelationGraph.mockImplementationOnce(
    () => new Promise((resolve) => (release = () => resolve({}))),
  );
  const caller = createContactMetricsRouter(() => runtime).createCaller({});
  const binding = { expectedAccountUin: '99999', expectedAccountConfigId: 'synthetic' };
  const id = await caller.rebuild({ ...binding, target: 'groupMembers' });
  await vi.waitFor(() => expect(release).toBeDefined());
  const snapshot = vi.spyOn(runtime.cache, 'snapshot');
  expect(await caller.status(binding)).toMatchObject({
    taskId: id,
    target: 'groupMembers',
    relationGraphRevision: 0,
    progress: { status: 'running', done: 2, total: 2 },
  });
  expect(snapshot).not.toHaveBeenCalled();
  expect(backgroundTasks.snapshot().find((task) => task.id === id)?.status).toBe('running');
  release();
  await vi.waitFor(() => expect(runtime.status().progress.status).toBe('completed'));
  expect(await caller.status(binding)).toMatchObject({ relationGraphRevision: 1 });
});

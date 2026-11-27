// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { backgroundTasks } from '../src/main/background_tasks';
import { taskArchiveRouter } from '../src/main/ipc/routers/task_archive';
import { TaskArchiveStore } from '../src/main/task_archive';
import { exportTaskResult } from '../src/shared/export_task_result';

const fixture = vi.hoisted(() => ({
  root: '',
  configId: 'source',
  exports: new Map<
    string,
    {
      id: string;
      updatedAt: number;
      status: string;
      save?: { status: string };
      resource?: { kind: string };
    }
  >(),
  finalizing: new Set<string>(),
  remove: vi.fn((id: string) => fixture.exports.delete(id)),
  resume: vi.fn((id: string) => {
    const task = fixture.exports.get(id);
    if (task?.status !== 'paused') return false;
    task.status = 'pending';
    return true;
  }),
  roaming: [{ id: 'check', status: 'paused', updatedAt: 2 }],
  startRoaming: vi.fn(),
  flash: [{ id: 'download', status: 'failed', interrupted: true, canRetry: true, finishedAt: 2 }],
  retryFlash: vi.fn((_id: string, _options?: { background?: boolean }) => Promise.resolve(true)),
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: fixture.configId }) },
    exportManager: {
      getTask: (id: string) => fixture.exports.get(id),
      isTaskFinalizing: (id: string) => fixture.finalizing.has(id),
      deleteTask: fixture.remove,
      resumeTask: fixture.resume,
    },
    roamingBackfill: { list: () => fixture.roaming, start: fixture.startRoaming },
    flashTransferFiles: {
      downloads: { load: async () => {}, list: () => fixture.flash, retry: fixture.retryFlash },
    },
  };
  return {
    getAppContext: () => ({ account: { context: { uin: '10001' } }, services }),
    requirePlatform: () => ({ appDataRoot: () => fixture.root }),
  };
});
vi.mock('../src/main/ipc/routers/background_tasks', () => ({ removeHostBackgroundTask: vi.fn() }));
vi.mock('../src/main/ipc/routers/client_state', async () => {
  const { z } = await import('zod/v3');
  return {
    clientAccountBinding: z.object({
      expectedAccountUin: z.string(),
      expectedAccountConfigId: z.string(),
    }),
  };
});
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source' };
const caller = taskArchiveRouter.createCaller({});
const ref = (id: string, result = 'completed:saved:1') => ({ id: `export:${id}`, result });
const change = (
  action: Parameters<typeof caller.change>[0]['action'],
  ...tasks: Parameters<typeof caller.change>[0]['tasks']
) => caller.change({ ...binding, action, tasks });

beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'weq-task-archive-'));
  fixture.configId = 'source';
  fixture.exports.clear();
  fixture.finalizing.clear();
  vi.clearAllMocks();
});
afterEach(() => rmSync(fixture.root, { recursive: true, force: true }));

it('迁移旧归档后，活动订阅只发变更摘要，明细仍可按结果版本取回', async () => {
  const directory = join(fixture.root, 'config', 'accounts', 'source');
  mkdirSync(directory, { recursive: true });
  const legacyId = 'background:window:old';
  const legacy = {
    result: 'completed:1',
    archivedAt: 1,
    snapshot: {
      id: 'old',
      kind: 'forward',
      name: '旧转发',
      status: 'completed',
      startedAt: 0,
      updatedAt: 1,
      actions: [],
      details: ['详细内容'],
      logs: [{ seq: 1, at: 1, text: '日志' }],
    },
  };
  const legacyPath = join(directory, 'task-archive.json');
  writeFileSync(legacyPath, JSON.stringify({ [legacyId]: legacy }));
  const before = await caller.summaries(binding);
  expect(before.entries[legacyId]?.snapshot).toMatchObject({ progress: 100 });
  expect(before.entries[legacyId]?.snapshot?.details).toBeUndefined();
  expect(await caller.detail({ ...binding, id: legacyId, result: legacy.result })).toEqual({
    ...legacy.snapshot,
    progress: 100,
  });
  expect(await caller.detail({ ...binding, id: legacyId, result: 'completed:2' })).toBeNull();

  const next = vi.fn();
  const subscription = (await caller.changes(binding)).subscribe({ next });
  try {
    fixture.exports.set('file', {
      id: 'file',
      status: 'completed',
      updatedAt: 1,
      save: { status: 'saved' },
    });
    expect((await change('archive', ref('file'))).changed).toBe(1);
    expect(next.mock.calls).toEqual([
      [{ generation: before.generation, revision: before.revision }],
      [
        {
          generation: before.generation,
          revision: before.revision + 1,
          patch: {
            'export:file': { result: 'completed:saved:1', archivedAt: expect.any(Number) },
          },
        },
      ],
    ]);
    const reopened = new TaskArchiveStore(legacyPath);
    expect(reopened.get(legacyId)?.snapshot?.details).toEqual(['详细内容']);
    expect(reopened.get('export:file')?.result).toBe('completed:saved:1');
  } finally {
    subscription.unsubscribe();
  }
});

it.each([
  ['failed', 35],
  ['cancelled', 0],
] as const)('保存 %s 转发回执时保留实际进度 %i%%', async (status, progress) => {
  const id = 'background:window:forward';
  const result = `${status}:2`;
  const ref = {
    id,
    result,
    receipt: {
      id: 'forward',
      kind: 'forward' as const,
      name: '转发任务',
      status,
      progress,
      startedAt: 1,
      updatedAt: 2,
      finishedAt: 2,
    },
  };
  expect((await change('record', ref)).changed).toBe(1);
  expect((await caller.summaries(binding)).entries[id]?.snapshot).toMatchObject({
    status,
    progress,
  });
  expect(await caller.detail({ ...binding, id, result })).toMatchObject({ status, progress });
});

it('归档完整保存结果但不清理产物，恢复抑制当前结果的自动归档，仅归档后才删除', async () => {
  fixture.exports.set('file', {
    id: 'file',
    status: 'completed',
    updatedAt: 1,
    save: { status: 'saved' },
    resource: { kind: 'media' },
  });
  const task = ref('file');
  expect(await caller.remove({ ...binding, task })).toBe(false);
  expect((await change('auto', task)).changed).toBe(1);
  expect(fixture.remove).not.toHaveBeenCalled();
  const reopened = new TaskArchiveStore(
    join(fixture.root, 'config', 'accounts', 'source', 'task-archive.json'),
  );
  expect(reopened.snapshot()[task.id]).toMatchObject({
    result: task.result,
    seen: true,
    archivedAt: expect.any(Number),
  });
  expect((await change('restore', task)).changed).toBe(1);
  expect((await caller.list(binding))[task.id]).toMatchObject({ restored: true, seen: true });
  expect((await change('auto', task)).changed).toBe(0);
  expect(await caller.remove({ ...binding, task })).toBe(false);
  expect((await change('archive', task)).changed).toBe(1);
  expect(await caller.remove({ ...binding, task })).toBe(true);
  expect(fixture.remove.mock.calls).toEqual([['file']]);
  expect(await caller.list(binding)).toEqual({});
});

it('手动归档涵盖暂停和待保存，排队、运行、保存和收尾期间不可归档', async () => {
  for (const [id, status, save] of [
    ['waiting', 'completed', undefined],
    ['waiting-save', 'completed', 'pending'],
    ['queued', 'pending', undefined],
    ['running', 'running', undefined],
    ['saving', 'completed', 'saving'],
    ['paused', 'paused', undefined],
    ['finalizing', 'paused', undefined],
    ['formal', 'completed', 'saved'],
    ['failed', 'failed', undefined],
  ] as const)
    fixture.exports.set(id, {
      id,
      status,
      updatedAt: 1,
      save: save ? { status: save } : undefined,
    });
  fixture.finalizing.add('finalizing');
  const selected = [...fixture.exports.values()].map((task) =>
    exportTaskResult(task as Parameters<typeof exportTaskResult>[0]),
  );
  expect((await change('auto', ...selected)).changed).toBe(0);
  expect((await change('archive', ref('formal', 'completed:saved:0'))).changed).toBe(0);
  expect((await change('archive', ...selected)).changed).toBe(5);
  expect(Object.keys(await caller.list(binding))).toEqual([
    'export:waiting',
    'export:waiting-save',
    'export:paused',
    'export:formal',
    'export:failed',
  ]);
  const paused = ref('paused', 'paused::1');
  expect((await change('restore', paused)).changed).toBe(1);
  expect(fixture.exports.get('paused')?.status).toBe('paused');
  expect(fixture.resume).not.toHaveBeenCalled();
  fixture.exports.get('formal')!.updatedAt = 2;
  expect(await caller.remove({ ...binding, task: ref('formal') })).toBe(false);
  fixture.configId = 'backup';
  await expect(caller.list(binding)).rejects.toThrow('数据源已切换');
  expect(await caller.list({ ...binding, expectedAccountConfigId: 'backup' })).toEqual({});
});

it('浏览器取回前可手动归档，交付状态不会触发自动归档', async () => {
  const browser = taskArchiveRouter.createCaller({ authorize: () => {} });
  fixture.exports.set('web', {
    id: 'web',
    status: 'completed',
    updatedAt: 2,
    resource: { kind: 'media' },
  });
  const task = ref('web', 'completed::2');
  const apply = (action: Parameters<typeof caller.change>[0]['action']) =>
    browser.change({ ...binding, action, tasks: [task] });
  expect((await apply('auto')).changed).toBe(0);
  expect((await apply('archive')).changed).toBe(1);
  expect((await apply('restore')).changed).toBe(1);
  expect((await apply('deliver')).changed).toBe(1);
  expect((await apply('auto')).changed).toBe(0);
  expect((await apply('archive')).changed).toBe(1);
});

it('已归档的暂停导出直接续作，拒绝或版本过期时保留归档', async () => {
  fixture.exports.set('file', { id: 'file', status: 'paused', updatedAt: 1 });
  const task = ref('file', 'paused::1');
  expect((await change('archive', task)).changed).toBe(1);
  expect(fixture.exports.get('file')?.status).toBe('paused');
  expect(await caller.resume({ ...binding, task: ref('file', 'paused::0') })).toEqual({
    resumed: false,
  });
  expect(fixture.resume).not.toHaveBeenCalled();
  fixture.resume.mockReturnValueOnce(false);
  expect(await caller.resume({ ...binding, task })).toEqual({ resumed: false });
  expect((await caller.list(binding))[task.id]?.archivedAt).toEqual(expect.any(Number));
  expect(await caller.resume({ ...binding, task })).toMatchObject({
    resumed: true,
    delta: { patch: { [task.id]: null } },
  });
  expect(fixture.exports.get('file')?.status).toBe('pending');
  expect(await caller.list(binding)).toEqual({});
});

it('等待核对的暂停回执可以归档和取消归档', async () => {
  const task = {
    id: 'background:window:forward',
    result: 'paused:2',
    receipt: {
      id: 'forward',
      name: '合成转发',
      kind: 'forward',
      status: 'paused',
      needsConfirmation: true,
      startedAt: 1,
      updatedAt: 2,
    },
  } as const;
  expect((await change('archive', task)).changed).toBe(1);
  expect(await caller.resume({ ...binding, task })).toEqual({ resumed: false });
  expect((await change('restore', task)).changed).toBe(1);
  expect((await caller.list(binding))[task.id]).toMatchObject({
    restored: true,
    snapshot: { status: 'paused', needsConfirmation: true },
  });
});

it('闪传接受续作前保留归档并避免同一记录被重复操作', async () => {
  const task = { id: 'flash:download', result: 'failed:2' };
  expect((await change('archive', task)).changed).toBe(1);
  const accepted = Promise.withResolvers<boolean>();
  const started = Promise.withResolvers<void>();
  fixture.retryFlash.mockImplementationOnce(() => {
    started.resolve();
    return accepted.promise;
  });
  const resuming = caller.resume({ ...binding, task });
  await started.promise;
  try {
    expect(fixture.retryFlash).toHaveBeenCalledWith('download', { background: true });
    expect(await caller.resume({ ...binding, task })).toEqual({ resumed: false });
    expect((await change('restore', task)).changed).toBe(0);
    expect(await caller.remove({ ...binding, task })).toBe(false);
    expect((await caller.list(binding))[task.id]?.archivedAt).toEqual(expect.any(Number));
  } finally {
    accepted.resolve(true);
  }
  expect(await resuming).toMatchObject({ resumed: true });
  expect(await caller.list(binding)).toEqual({});
});

it('暂停的漫游和后台任务沿用原续作操作', async () => {
  const id = backgroundTasks.start({ kind: 'model', name: '合成模型' });
  backgroundTasks.finish(id, 'paused');
  backgroundTasks.setActions(id, [
    { id: 'continue', label: '继续下载', run: () => backgroundTasks.resume(id) },
  ]);
  const model = backgroundTasks.snapshot().find((task) => task.id === id)!;
  const roaming = { id: 'roaming:check', result: 'paused:2' };
  const download = { id: `background:host:${id}`, result: `paused:${model.updatedAt}` };
  try {
    expect((await change('archive', roaming, download)).changed).toBe(2);
    expect(await caller.resume({ ...binding, task: roaming })).toMatchObject({ resumed: true });
    expect(fixture.startRoaming).toHaveBeenCalledWith('check');
    expect(await caller.resume({ ...binding, task: download })).toMatchObject({ resumed: true });
    expect(backgroundTasks.snapshot().find((task) => task.id === id)?.status).toBe('running');
    expect(await caller.list(binding)).toEqual({});
  } finally {
    backgroundTasks.finish(id, 'cancelled');
    backgroundTasks.remove(id);
  }
});

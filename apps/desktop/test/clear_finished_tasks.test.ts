// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  remove: vi.fn((id: string) => fixture.exports.delete(id)),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: { context: { uin: '10001' } },
    services: {
      accountConfig: { getRecord: () => ({ configId: fixture.configId }) },
      exportManager: {
        getTask: (id: string) => fixture.exports.get(id),
        deleteTask: fixture.remove,
      },
    },
  }),
  requirePlatform: () => ({ appDataRoot: () => fixture.root }),
}));
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
  fixture.remove.mockClear();
});
afterEach(() => rmSync(fixture.root, { recursive: true, force: true }));

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

it('批量归档核对结果版本，跳过进行中、待取回和未保存结果；正式导出仅手动归档', async () => {
  for (const [id, status, save] of [
    ['waiting', 'completed', undefined],
    ['running', 'running', undefined],
    ['saving', 'completed', 'saving'],
    ['paused', 'paused', undefined],
    ['formal', 'completed', 'saved'],
    ['failed', 'failed', undefined],
  ] as const)
    fixture.exports.set(id, {
      id,
      status,
      updatedAt: 1,
      save: save ? { status: save } : undefined,
    });
  const selected = [...fixture.exports.values()].map((task) =>
    exportTaskResult(task as Parameters<typeof exportTaskResult>[0]),
  );
  expect((await change('auto', ...selected)).changed).toBe(0);
  expect((await change('archive', ref('formal', 'completed:saved:0'))).changed).toBe(0);
  expect((await change('archive', ...selected)).changed).toBe(2);
  expect(Object.keys(await caller.list(binding))).toEqual(['export:formal', 'export:failed']);
  fixture.exports.get('formal')!.updatedAt = 2;
  expect(await caller.remove({ ...binding, task: ref('formal') })).toBe(false);
  fixture.configId = 'backup';
  await expect(caller.list(binding)).rejects.toThrow('数据源已切换');
  expect(await caller.list({ ...binding, expectedAccountConfigId: 'backup' })).toEqual({});
});

it('浏览器取回前保留产物，交给浏览器后只允许手动归档', async () => {
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
  expect((await apply('archive')).changed).toBe(0);
  expect((await apply('deliver')).changed).toBe(1);
  expect((await apply('auto')).changed).toBe(0);
  expect((await apply('archive')).changed).toBe(1);
});

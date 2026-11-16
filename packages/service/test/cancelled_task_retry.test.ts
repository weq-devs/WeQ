import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';
import { withExportSaveDirectory } from './support/export_save_fixture';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('取消的资源等旧执行器退出后可重新执行，不发布旧执行器迟到的结果', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-cancel-retry-'));
  roots.push(root);
  const manager = new ExportTaskManager({} as MsgService, root);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn(async ({ directory }: { directory: string }) => {
    if (run.mock.calls.length === 1) await gate;
    writeFileSync(join(directory, 'result.txt'), 'retried');
    return { total: 1, ok: 1, failed: [], fileName: 'result.txt' };
  });
  const id = await manager.startResourceExport({
    name: '合成下载',
    kind: 'group-files',
    output: { kind: 'file', name: 'result', extension: 'txt' },
    savePolicy: { mode: 'before', directory: root },
    run,
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(manager.cancelTask(id)).toBe(true);
  expect(manager.resumeTask(id)).toBe(false);
  release();
  await (manager as unknown as { queue: Promise<void> }).queue;
  expect(manager.getTask(id)?.bundleDir).toBeUndefined();
  expect(manager.listTasks()[0]).toMatchObject({ canResume: true, resumeMode: 'restart' });
  const restored = new ExportTaskManager({} as MsgService, root);
  expect(restored.listTasks()[0]?.canResume).toBe(false);
  expect(manager.resumeTask(id)).toBe(true);
  expect(manager.resumeTask(id)).toBe(false);
  await (manager as unknown as { queue: Promise<void> }).queue;
  expect(run).toHaveBeenCalledTimes(2);
  expect(manager.getTask(id)).toMatchObject({ status: 'completed', current: 1 });
  expect(readFileSync(manager.getTask(id)!.filePath!, 'utf8')).toBe('retried');
});

it('可重建的收藏导出取消后重启仍可重试，不沿用已清除的检查点', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-collection-retry-'));
  roots.push(root);
  let manager: ExportTaskManager;
  const listCollections = vi.fn(async () => {
    if (listCollections.mock.calls.length === 1) manager.cancelTask(manager.listTasks()[0]!.id);
    return [];
  });
  const deps = withExportSaveDirectory(root, { collection: { listCollections } });
  manager = new ExportTaskManager({} as MsgService, root, deps);
  const id = await manager.startTask({
    kind: 'c2c',
    conv: 'collections',
    name: '合成收藏',
    format: 'json',
    total: 0,
    collection: {},
  });
  await (manager as unknown as { queue: Promise<void> }).queue;
  const restored = new ExportTaskManager({} as MsgService, root, deps);
  expect(restored.listTasks()[0]).toMatchObject({
    status: 'cancelled',
    canResume: true,
    resumeMode: 'restart',
  });
  expect(restored.resumeTask(id)).toBe(true);
  await (restored as unknown as { queue: Promise<void> }).queue;
  expect(restored.getTask(id)?.status).toBe('completed');
  expect(listCollections).toHaveBeenCalledTimes(2);
});

it('排队中的任务取消并重试，只执行一次，不被新旧队列项重复启动', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-pending-retry-'));
  roots.push(root);
  const listCollections = vi.fn(async () => []);
  const manager = new ExportTaskManager(
    {} as MsgService,
    root,
    withExportSaveDirectory(root, { collection: { listCollections } }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await manager.startResourceExport({
    name: '阻塞夹具',
    kind: 'group-files',
    run: async () => {
      await gate;
      return { total: 0, ok: 0, failed: [] };
    },
  });
  const id = await manager.startTask({
    kind: 'c2c',
    conv: 'collections',
    name: '排队收藏',
    format: 'json',
    total: 0,
    collection: {},
  });
  expect(manager.getTask(id)?.status).toBe('pending');
  manager.cancelTask(id);
  expect(manager.resumeTask(id)).toBe(true);
  release();
  await (manager as unknown as { queue: Promise<void> }).queue;
  expect(manager.getTask(id)?.status).toBe('completed');
  expect(listCollections).toHaveBeenCalledOnce();
});

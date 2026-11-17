import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';
import { withExportSaveDirectory } from './support/export_save_fixture';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc000000301010018dd8db00000000049454e44ae426082',
  'hex',
);

it.each(['market', 'emoji'] as const)(
  '%s 完成若干图片后暂停，重启只处理余项，固定原清单且不产生重名副本',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-item-resume-'));
    roots.push(root);
    const cache = join(root, 'cache');
    const source = join(root, 'source.png');
    writeFileSync(source, PNG);
    const ids = Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(6, '0'));
    const read = vi.fn(async (_pack: string, _hash: string) => source);
    const download = vi.fn(async (_url: string, path: string) => {
      writeFileSync(path, PNG);
      return true;
    });
    const details = vi.fn(async () => ({ items: ids.map((hash) => ({ hash, name: '同名图片' })) }));
    const list = vi.fn(async () =>
      ids.map((key) => ({
        key,
        oriPath: null,
        thumbPath: null,
        remoteUrl: `https://fixture.invalid/${key}`,
      })),
    );
    const deps = withExportSaveDirectory(cache, {
      marketpack: {
        getPackDetail: details,
        getPackKey: async () => ({ key: 'synthetic-key' }),
        getPackImagePath: read,
      },
      emojipack: { listOwnItems: list, listReceivedItems: async () => [], downloadImage: download },
    });
    const manager = new ExportTaskManager({} as MsgService, cache, deps);
    let paused = false;
    manager.on('progress', (event) => {
      if (!paused && event.status === 'running' && event.current >= 1) {
        paused = true;
        manager.pauseTask(event.taskId);
      }
      if (
        !paused &&
        kind === 'emoji' &&
        manager.getTask(event.taskId)?.stages.find((stage) => stage.key === 'emojidownload')
          ?.current
      ) {
        paused = true;
        manager.pauseTask(event.taskId);
      }
    });
    const id =
      kind === 'market'
        ? await manager.startMarketPackDownload([{ id: '100', name: '合成表情' }])
        : await manager.startEmojiPackExport(['own']);
    await vi.waitFor(() =>
      expect(manager.listTasks()[0]).toMatchObject({
        status: 'paused',
        canResume: true,
        resumeMode: 'checkpoint',
      }),
    );
    const restored = new ExportTaskManager({} as MsgService, cache, deps);
    expect(restored.resumeTask(id)).toBe(true);
    await (restored as unknown as { queue: Promise<void> }).queue;
    expect(restored.getTask(id)?.status, restored.getTask(id)?.error).toBe('completed');
    const task = restored.getTask(id)!;
    expect(task.current).toBe(10);
    expect(
      readdirSync(join(task.bundleDir!, kind === 'market' ? '合成表情' : '我的表情')),
    ).toHaveLength(10);
    if (kind === 'market') {
      expect(details).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(10);
      expect(new Set(read.mock.calls.map((call) => call[1])).size).toBe(10);
    } else {
      expect(list).toHaveBeenCalledOnce();
      expect(download).toHaveBeenCalledTimes(10);
      expect(new Set(download.mock.calls.map((call) => call[0])).size).toBe(10);
    }
  },
);

it.each([
  'database',
  'assistant-artifact',
  'annual-report',
  'analytics-report',
  'persona-bot',
  'composition',
] as const)('%s 一次性任务只支持取消，不提供虚假的手动暂停或恢复', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'weq-cancel-only-'));
  roots.push(root);
  const manager = new ExportTaskManager({} as MsgService, root, withExportSaveDirectory(root));
  let entered = false;
  const id = await manager.startResourceExport({
    kind,
    name: kind,
    run: async ({ signal }) => {
      entered = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      return { total: 0, ok: 0, failed: [] };
    },
  });
  await vi.waitFor(() => expect(entered).toBe(true));
  expect(manager.listTasks()[0]).toMatchObject({ canPause: false, canResume: false });
  expect(manager.pauseTask(id)).toBe(false);
  expect(manager.cancelTask(id)).toBe(true);
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('cancelled'));
  expect(manager.resumeTask(id)).toBe(false);
  await (manager as unknown as { queue: Promise<void> }).queue;
});

it('可续作资源重启后按持久请求重建运行器，只写剩余文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-resource-resume-'));
  roots.push(root);
  const cache = join(root, 'cache');
  const copied = vi.fn(async (path: string) => writeFileSync(path, 'synthetic'));
  const run = async (
    context: import('../src/account/export/task_manager').ResourceExportRunContext,
  ) => {
    for (const [index, name] of ['first', 'second'].entries()) {
      const path = join(context.directory, `${name}.txt`);
      await context.checkpoint!.file(name, path, () => copied(path));
      context.progress(index + 1, 2);
    }
    return { total: 2, ok: 2, failed: [] };
  };
  const manager = new ExportTaskManager({} as MsgService, cache, withExportSaveDirectory(cache));
  let paused = false;
  manager.on('progress', (event) => {
    if (!paused && event.status === 'running' && event.current === 1) {
      paused = true;
      manager.pauseTask(event.taskId);
    }
  });
  const ids = ['one', 'two'];
  const id = await manager.startResourceExport({
    kind: 'mail-messages',
    name: '合成邮件',
    resume: { type: 'mail', ids },
    run,
  });
  ids.push('not-selected');
  await vi.waitFor(() =>
    expect(manager.listTasks()[0]).toMatchObject({
      status: 'paused',
      canResume: true,
      canPause: true,
    }),
  );
  const resumeResource = vi.fn(
    async (
      request: import('../src/account/export/task_manager').ResumableResourceRequest,
      context: import('../src/account/export/task_manager').ResourceExportRunContext,
    ) => {
      expect(request).toEqual({ type: 'mail', ids: ['one', 'two'] });
      return run(context);
    },
  );
  const restored = new ExportTaskManager(
    {} as MsgService,
    cache,
    withExportSaveDirectory(cache, { resumeResource }),
  );
  expect(restored.resumeTask(id)).toBe(true);
  await (restored as unknown as { queue: Promise<void> }).queue;
  expect(restored.getTask(id)?.status, restored.getTask(id)?.error).toBe('completed');
  expect(resumeResource).toHaveBeenCalledOnce();
  expect(copied).toHaveBeenCalledTimes(2);
  expect(readdirSync(join(restored.getTask(id)!.bundleDir!, 'files'))).toEqual([
    'first.txt',
    'second.txt',
  ]);
  expect(readdirSync(cache).some((entry) => entry.startsWith('resume-'))).toBe(false);
});

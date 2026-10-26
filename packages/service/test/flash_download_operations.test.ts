// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FlashTransferDownloadManager } from '../src/account/flashtransfer/manager';
import { FlashTransferResolver } from '../src/account/flashtransfer/resolver';
import { FlashTransferClient } from '../src/account/flashtransfer/client';

afterEach(() => vi.restoreAllMocks());

it('清除以整次操作为单位，成功文件不会从尚未成功的整批中被单独移除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weq-flash-batch-clear-'));
  try {
    await writeFile(
      join(dir, 'tasks.json'),
      JSON.stringify(
        [
          { id: 'a', batchId: 'done', status: 'done' },
          { id: 'b', batchId: 'done', status: 'done' },
          { id: 'c', batchId: 'mixed', status: 'done' },
          { id: 'd', batchId: 'mixed', status: 'downloading' },
          { id: 'e', batchId: 'partial', status: 'done', resolutionErrors: ['目录读取失败'] },
        ].map((task) => ({
          filesetId: 'set',
          filesetName: '合成资料',
          name: task.id,
          physicalId: task.id,
          relativePath: task.id,
          targetPath: join(dir, task.id),
          createdAt: 1,
          fileSize: 100,
          downloadedBytes: 100,
          ...task,
        })),
      ),
    );
    const manager = new FlashTransferDownloadManager(dir);
    await manager.load();
    expect(await manager.clearCompleted(['done', 'mixed', 'partial', 'c'])).toBe(1);
    expect(manager.list().map((task) => task.id)).toEqual(['mixed', 'partial']);
    expect(manager.list()[0]!.files).toHaveLength(2);
    expect(await manager.clearFinished()).toBe(1);
    await manager.load();
    expect(manager.list().map((task) => task.id)).toEqual(['mixed']);
    expect(manager.list()[0]!.files).toHaveLength(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('一次下载建立一个持久化任务，整批取消并保留各文件详情', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weq-flash-operation-'));
  let release = (_url: string) => {};
  const url = new Promise<string>((resolve) => {
    release = resolve;
  });
  vi.spyOn(FlashTransferResolver.prototype, 'resolveDownloads').mockResolvedValue({
    files: ['a', 'b'].map((name) => ({
      name,
      relativePath: name,
      physicalId: name,
      fileSize: 100,
      filesetId: 'set',
    })),
    errors: [],
  });
  vi.spyOn(FlashTransferClient.prototype, 'getDownloadUrl').mockReturnValue(url);
  try {
    const manager = new FlashTransferDownloadManager(dir);
    await manager.load();
    await manager.start('合成资料', 'set', []);
    expect(manager.list()).toHaveLength(1);
    const task = manager.list()[0]!;
    expect(task).toMatchObject({ name: '合成资料', fileSize: 200 });
    expect(await manager.cancel(task.id)).toBe(true);
    expect(manager.list()[0]).toMatchObject({
      status: 'cancelled',
      files: [
        expect.objectContaining({ status: 'cancelled' }),
        expect.objectContaining({ status: 'cancelled' }),
      ],
    });
    const reloaded = new FlashTransferDownloadManager(dir);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]!.id).toBe(task.id);
    expect(await reloaded.clearCompleted([task.id])).toBe(0);
    expect(await reloaded.clearFinished()).toBe(1);
  } finally {
    release('unused');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(dir, { recursive: true, force: true });
  }
});

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
    expect(manager.list()[0]).toMatchObject({ interrupted: true, canRetry: true });
    expect(manager.list()[0]!.files).toMatchObject([
      { status: 'done' },
      { interrupted: true, status: 'failed' },
    ]);
    expect(await manager.clearFinished()).toBe(1);
    await manager.load();
    expect(manager.list().map((task) => task.id)).toEqual(['mixed']);
    expect(manager.list()[0]!.files).toHaveLength(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('重启后不自动发起下载；重试只请求未完成文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weq-flash-resume-'));
  const next = Promise.withResolvers<string>();
  const getUrl = vi
    .spyOn(FlashTransferClient.prototype, 'getDownloadUrl')
    .mockReturnValue(next.promise);
  try {
    await writeFile(
      join(dir, 'tasks.json'),
      JSON.stringify(
        ['done', 'pending', 'resolving', 'downloading'].map((status) => ({
          id: status,
          physicalId: status,
          batchId: 'batch',
          name: status,
          relativePath: status,
          targetPath: join(dir, status),
          status,
          fileSize: 10,
          downloadedBytes: 10,
          createdAt: 1,
        })),
      ),
    );
    const manager = new FlashTransferDownloadManager(dir);
    await manager.load();
    expect(getUrl).not.toHaveBeenCalled();
    expect(await manager.retry('batch')).toBe(true);
    expect(getUrl.mock.calls).toEqual([['pending'], ['resolving'], ['downloading']]);
    await manager.cancel('batch');
    next.resolve('unused');
    await vi.waitFor(() => expect(manager.list()[0]?.canRetry).toBe(true));
    expect(manager.list()[0]?.files[0]?.status).toBe('done');
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
    await manager.start('合成资料', 'set', [], dir);
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

it('暂停闪传收尾前不能启动同一批，收尾后可重试未完成文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weq-flash-pause-'));
  const pending = Promise.withResolvers<string>();
  vi.spyOn(FlashTransferResolver.prototype, 'resolveDownloads').mockResolvedValue({
    files: [
      { name: 'a', relativePath: 'a', physicalId: 'original', fileSize: 10, filesetId: 'set' },
    ],
    errors: [],
  });
  const urls = vi
    .spyOn(FlashTransferClient.prototype, 'getDownloadUrl')
    .mockReturnValue(pending.promise);
  try {
    const manager = new FlashTransferDownloadManager(dir);
    const { taskId } = await manager.start('合成操作', 'set', [], dir);
    expect(await manager.pause(taskId!)).toBe(true);
    expect(await manager.retry(taskId!)).toBe(false);
    pending.resolve('unused');
    await vi.waitFor(() =>
      expect(manager.list()[0]).toMatchObject({ interrupted: true, canRetry: true }),
    );
    expect(urls).toHaveBeenCalledOnce();
    expect(await manager.clearFinished()).toBe(0);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

it('交给后台只登记选中的下载批次，重开后保留批次身份', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weq-flash-background-'));
  const pending = Promise.withResolvers<string>();
  vi.spyOn(FlashTransferResolver.prototype, 'resolveDownloads').mockResolvedValue({
    files: [{ name: 'a', relativePath: 'a', physicalId: 'p', fileSize: 10, filesetId: 'zip' }],
    errors: [],
  });
  const urls = vi
    .spyOn(FlashTransferClient.prototype, 'getDownloadUrl')
    .mockReturnValue(pending.promise);
  try {
    const manager = new FlashTransferDownloadManager(dir);
    const a = (await manager.start('合成操作', 'zip', [], dir, 'share')).taskId!;
    const b = (await manager.start('合成操作', 'zip', [], dir, 'share')).taskId!;
    const visible = (source: FlashTransferDownloadManager) =>
      source.list((task) => !task.foreground).map((batch) => batch.id);
    expect(visible(manager)).toEqual([]);
    expect(await manager.background(a, '另一个分享')).toBe(false);
    expect(await manager.background(a, 'share')).toBe(true);
    expect(visible(manager)).toEqual([a]);
    expect(await manager.pause(a, true)).toBe(false);
    expect(await manager.pause(b, true)).toBe(true);
    expect(urls).toHaveBeenCalledTimes(2);
    await manager.cancel(a);
    pending.resolve('unused');
    await vi.waitFor(() => expect(manager.list().every((batch) => batch.canRetry)).toBe(true));
    const reopened = new FlashTransferDownloadManager(dir);
    await reopened.load();
    expect(visible(reopened)).toEqual([a]);
    expect(reopened.list((task) => task.viewFilesetId === 'share')).toHaveLength(2);
  } finally {
    pending.resolve('unused');
    await rm(dir, { force: true, recursive: true });
  }
});

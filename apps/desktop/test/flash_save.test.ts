// @vitest-environment node
import { mkdtemp, rm, realpath, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openFlashDownloadOutput, startFlashDownloads } from '../src/main/ipc/routers/flash_save';
import type { FlashDownloadBatch, FlashDownloadTask } from '@weq/service';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const input = {
  filesetName: '合成资料',
  selections: [
    {
      filesetId: 'set',
      fileId: 'file',
      physicalId: 'physical',
      name: 'file.txt',
      fileSize: 1,
      path: 'file.txt',
      isDir: false,
      isZipContent: false,
      zipFileId: '',
    },
  ],
};
function fixture(directory: string | null) {
  const start = vi.fn(async () => ({ started: 1, errors: [] }));
  const host = {
    pickDirectory: vi.fn(async () => directory),
    pickSaveTarget: vi.fn(async () => null),
  };
  return { manager: { start }, host, current: vi.fn() };
}
it('取消目录选择不解析或创建任务，闪传使用独立的位置记忆键', async () => {
  const f = fixture(null);
  expect(await startFlashDownloads(input, f.manager, f.host, f.current)).toMatchObject({
    cancelled: true,
    started: 0,
  });
  expect(f.manager.start).not.toHaveBeenCalled();
  expect(f.host.pickDirectory).toHaveBeenCalledWith(
    expect.objectContaining({ locationKey: 'flash-downloads' }),
  );
});
it('每次下载都询问目录，目录失效不回退到缓存，账号切换不创建任务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-flash-destination-'));
  roots.push(root);
  const f = fixture(root);
  await startFlashDownloads(input, f.manager, f.host, f.current);
  await startFlashDownloads(input, f.manager, f.host, f.current);
  expect(f.host.pickDirectory).toHaveBeenCalledTimes(2);
  expect(f.manager.start).toHaveBeenCalledWith(input.filesetName, 'set', input.selections, root);
  f.host.pickDirectory.mockResolvedValueOnce(join(root, 'missing'));
  await expect(startFlashDownloads(input, f.manager, f.host, f.current)).rejects.toThrow(
    '保存目录不可用',
  );
  const current = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw new Error('账号已切换');
    });
  await expect(startFlashDownloads(input, f.manager, f.host, current)).rejects.toThrow(
    '账号已切换',
  );
  expect(f.manager.start).toHaveBeenCalledTimes(2);
});
it('Web 使用服务器保存根，拒绝越界目录，不采用客户端文件路径', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'weq-flash-web-destination-')));
  roots.push(root);
  const f = fixture(null);
  await startFlashDownloads(input, f.manager, { ...f.host, exportRoot: root }, f.current);
  expect(f.manager.start).toHaveBeenCalledWith(input.filesetName, 'set', input.selections, root);
  await expect(
    startFlashDownloads(
      { ...input, directory: '../outside' },
      f.manager,
      { ...f.host, exportRoot: root },
      f.current,
    ),
  ).rejects.toThrow();
});

it('闪传仅打开记录中的已完成单文件，定位与多文件目录复用宿主能力', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-flash-open-'));
  roots.push(root);
  const path = join(root, 'file.txt');
  await writeFile(path, 'fixture');
  const file: FlashDownloadTask = {
    id: 'file',
    filesetId: 'set',
    filesetName: '集合',
    name: '文件',
    physicalId: 'physical',
    relativePath: 'file.txt',
    targetPath: path,
    fileSize: 7,
    status: 'done',
    downloadedBytes: 7,
    createdAt: 0,
  };
  let task: FlashDownloadBatch = { ...file, id: 'batch', files: [file] };
  const manager = { list: () => [task] };
  const host = {
    canReveal: true,
    revealPath: vi.fn(async () => {}),
    revealInFolder: vi.fn(async () => {}),
  };
  const current = vi.fn();
  const open = (mode: 'file' | 'directory' | 'reveal' = 'file', taskId = 'batch') =>
    openFlashDownloadOutput({ taskId, mode }, manager, host, current);
  await open();
  expect(host.revealPath).toHaveBeenLastCalledWith(path);
  await open('reveal');
  expect(host.revealInFolder).toHaveBeenCalledWith(path);
  expect(current).toHaveBeenCalledTimes(4);
  await expect(open('file', 'missing')).rejects.toThrow('下载记录不存在');
  for (const status of ['pending', 'resolving', 'downloading', 'failed', 'cancelled'] as const) {
    task = { ...task, files: [{ ...file, status }] };
    await expect(open()).rejects.toThrow('已完成的单文件');
  }
  await mkdir(join(root, 'nested'));
  task = {
    ...task,
    files: [file, { ...file, id: 'second', targetPath: join(root, 'nested', 'second.txt') }],
  };
  await expect(open()).rejects.toThrow('已完成的单文件');
  await open('directory');
  expect(host.revealPath).toHaveBeenLastCalledWith(root);
  task = { ...task, files: [file] };
  const calls = host.revealPath.mock.calls.length;
  host.canReveal = false;
  await expect(open()).rejects.toThrow('当前浏览器');
  host.canReveal = true;
  current
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error('账号已切换');
    });
  await expect(open()).rejects.toThrow('账号已切换');
  expect(host.revealPath).toHaveBeenCalledTimes(calls);
  await rm(path);
  await expect(open()).rejects.toThrow('已移动或删除');
  expect(host.revealPath).toHaveBeenCalledTimes(calls);
});

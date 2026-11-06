// @vitest-environment node
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startFlashDownloads } from '../src/main/ipc/routers/flash_save';

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

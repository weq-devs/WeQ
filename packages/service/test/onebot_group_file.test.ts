import type { AccountSession } from '@weq/account';
import { ListGroupFiles } from '@weq/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupFileService } from '../src/account/group_file';

afterEach(() => vi.restoreAllMocks());
const service = () =>
  new GroupFileService({ sendOidbPacket: vi.fn() }, {} as AccountSession, () => 1);
const folders = [
  {
    folderId: 'dir',
    parentDirectoryId: '/',
    folderName: '目录',
    createTime: 1,
    modifiedTime: 1,
    creatorUin: 7,
    creatorName: '合成成员',
    totalFileCount: 0,
  },
];

it('群文件读取到末页，保留文件夹分页并逐页检查账号', async () => {
  const invoke = vi
    .spyOn(ListGroupFiles, 'invoke')
    .mockResolvedValueOnce({ files: [], folders, isEnd: false })
    .mockResolvedValueOnce({ files: [], folders: [], isEnd: true });
  const beforeRequest = vi.fn();
  expect(await service().list(42, '/', { beforeRequest })).toMatchObject({
    folders: [{ folderId: 'dir' }],
  });
  expect(invoke).toHaveBeenLastCalledWith(expect.anything(), 1, {
    groupId: 42,
    targetDirectory: '/',
    startIndex: 100,
    pageSize: 100,
  });
  expect(beforeRequest).toHaveBeenCalledTimes(2);
});

it('分页上限不把部分结果当全量成功', async () => {
  vi.spyOn(ListGroupFiles, 'invoke').mockResolvedValue({ files: [], folders, isEnd: false });
  await expect(service().list(42)).rejects.toThrow('截断');
});

it('切号检查失败后不继续下一页', async () => {
  const invoke = vi
    .spyOn(ListGroupFiles, 'invoke')
    .mockResolvedValue({ files: [], folders, isEnd: false });
  const beforeRequest = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw Error('切号');
    });
  await expect(service().list(42, '/', { beforeRequest })).rejects.toThrow('切号');
  expect(invoke).toHaveBeenCalledTimes(1);
});

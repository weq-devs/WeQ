import type { AccountSession } from '@weq/account';
import {
  DeleteGroupFile,
  RenameGroupFile,
  MoveGroupFile,
  TransGroupFile,
  type GroupFileItem,
} from '@weqbot/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import type { QQGroupPermissionContext } from '../src/common/qq_permissions';
import { GroupFileService } from '../src/account/group_file';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const context = vi.fn(async (): Promise<QQGroupPermissionContext> => ({ role: 'member' }));
  const session = { context: { uin: '10001' }, selfUid: 'u_self' } as unknown as AccountSession;
  let pid = 1;
  const service = new GroupFileService({ sendOidbPacket: vi.fn() }, session, () => pid, context);
  const listing = vi.spyOn(service, 'list').mockResolvedValue({
    targetDirectory: '/folder',
    folders: [],
    files: [{ fileId: 'file', uploaderUin: 10001 } as GroupFileItem],
  });
  const remove = vi.spyOn(DeleteGroupFile, 'invoke').mockResolvedValue(undefined);
  const rename = vi.spyOn(RenameGroupFile, 'invoke').mockResolvedValue(undefined);
  const move = vi.spyOn(MoveGroupFile, 'invoke').mockResolvedValue(undefined);
  return {
    service,
    listing,
    context,
    remove,
    rename,
    move,
    switchPid: () => {
      pid = 2;
    },
  };
}
it('上传者可删除改名，但不能移动；所有权限由服务端读取上传者', async () => {
  const f = fixture();
  await f.service.renameFile(123, 'file', '/folder', 'name');
  await f.service.deleteFile(123, 'file', '/folder');
  await expect(f.service.moveFile(123, 'file', '/folder', '/')).rejects.toThrow('无权');
  expect(f.listing).toHaveBeenCalledWith(123, '/folder');
  expect(f.rename).toHaveBeenCalledOnce();
  expect(f.remove).toHaveBeenCalledOnce();
  expect(f.move).not.toHaveBeenCalled();
});
it('角色和资源归属变化后不复用旧权限', async () => {
  const f = fixture();
  f.context.mockResolvedValueOnce({ role: 'admin' });
  await f.service.moveFile(123, 'file', '/', '/folder');
  f.listing.mockResolvedValue({ targetDirectory: '/', folders: [], files: [] });
  await expect(f.service.deleteFile(123, 'file')).rejects.toThrow('无权');
  expect(f.remove).not.toHaveBeenCalled();
});
it('查询上传者期间 QQ 运行时发生变化，不继续删除', async () => {
  const f = fixture();
  f.listing.mockImplementation(async () => {
    f.switchPid();
    return {
      targetDirectory: '/',
      folders: [],
      files: [{ fileId: 'file', uploaderUin: 10001 } as GroupFileItem],
    };
  });
  await expect(f.service.deleteFile(123, 'file')).rejects.toThrow('运行时');
  expect(f.remove).not.toHaveBeenCalled();
});
it('未带目录的 OneBot 删除按需找到子目录内的本人文件，显式目录不扩查', async () => {
  const f = fixture();
  const root = { targetDirectory: '/', files: [], folders: [{ folderId: '/nested' }] };
  f.listing.mockImplementation(async (_groupId, directory = '/') =>
    directory === '/'
      ? (root as Awaited<ReturnType<typeof f.service.list>>)
      : {
          targetDirectory: directory,
          folders: [],
          files: [{ fileId: 'file', uploaderUin: 10001 } as GroupFileItem],
        },
  );
  await expect(f.service.deleteFile(123, 'file')).resolves.toBeUndefined();
  expect(f.listing).toHaveBeenNthCalledWith(2, 123, '/nested');
  f.remove.mockClear();
  await expect(f.service.deleteFile(123, 'file', '/')).rejects.toThrow('无权');
  expect(f.remove).not.toHaveBeenCalled();
});
it('未知文件的目录搜索有上限，不因服务端持续返回子目录无限扫描', async () => {
  const f = fixture();
  let serial = 0;
  f.listing.mockImplementation(
    async () =>
      ({
        targetDirectory: '/',
        files: [],
        folders: [{ folderId: `/folder-${++serial}` }],
      }) as Awaited<ReturnType<typeof f.service.list>>,
  );
  await expect(f.service.deleteFile(123, 'missing')).rejects.toThrow('parent_directory');
  expect(f.listing.mock.calls.length).toBeLessThan(100);
  expect(f.remove).not.toHaveBeenCalled();
});

it('转存只写未过期的临时文件，并按服务端目标读回明确的永久文件', async () => {
  const f = fixture();
  f.context.mockResolvedValue({ role: 'owner' });
  const transfer = vi
    .spyOn(TransGroupFile, 'invoke')
    .mockResolvedValue({ saveBusId: 102, saveFilePath: 'saved' });
  const file = {
    fileId: 'original',
    fileName: '测试',
    fileSize: 10,
    busId: 102,
    expireTime: Math.ceil(Date.now() / 1000) + 3600,
    expireTimeKnown: true,
  } as GroupFileItem;
  const listing = { targetDirectory: '/', folders: [], files: [file] };
  f.listing
    .mockResolvedValueOnce(listing)
    .mockResolvedValueOnce({ ...listing, files: [{ ...file, fileId: 'saved', expireTime: 0 }] });
  await expect(f.service.makePermanent(123, 'original', '/', () => {})).resolves.toEqual({
    state: 'accepted',
    fileId: 'saved',
    directory: '/',
  });
  expect(transfer).toHaveBeenCalledOnce();
  f.listing.mockResolvedValue({ ...listing, files: [{ ...file, expireTime: 0 }] });
  await expect(f.service.makePermanent(123, 'original', '/', () => {})).rejects.toThrow(
    '临时群文件',
  );
  expect(transfer).toHaveBeenCalledOnce();
});

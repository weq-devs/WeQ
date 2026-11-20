import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import {
  DeleteGroupFile,
  RenameGroupFile,
  MoveGroupFile,
  TransGroupFile,
  decode,
  encode,
  type GroupFileItem,
} from '@weqbot/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import type { QQGroupPermissionContext } from '../src/common/qq_permissions';
import { GroupFileService } from '../src/account/group_file';

afterEach(() => vi.restoreAllMocks());
function fixture(transferSourcesPath?: string) {
  const context = vi.fn(async (): Promise<QQGroupPermissionContext> => ({ role: 'member' }));
  const session = { context: { uin: '10001' }, selfUid: 'u_self' } as unknown as AccountSession;
  let pid = 1;
  const sendOidbPacket = vi.fn<NtHelperBinding['sendOidbPacket']>();
  const service = new GroupFileService(
    { sendOidbPacket },
    session,
    () => pid,
    context,
    transferSourcesPath,
  );
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
    sendOidbPacket,
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

it.each([102, 104])('业务号 %i 按原值提交，以群目录确认转存后的永久状态', async (busId) => {
  const f = fixture();
  f.context.mockResolvedValue({ role: 'owner' });
  f.sendOidbPacket.mockResolvedValue(
    Buffer.from(
      encode(TransGroupFile.respSchema, { transFile: { saveBusId: busId, saveFilePath: 'saved' } }),
    ),
  );
  const file = {
    fileId: 'original',
    fileName: '测试',
    fileSize: 10,
    busId,
    expireTime: Math.ceil(Date.now() / 1000) + 3600,
    expireTimeKnown: true,
  } as GroupFileItem;
  const listing = { targetDirectory: '/', folders: [], files: [file] };
  f.listing.mockResolvedValueOnce(listing).mockResolvedValueOnce({
    ...listing,
    files: [{ ...file, fileId: 'saved', busId: 102, expireTime: 0 }],
  });
  await expect(f.service.makePermanent(123, 'original', '/', () => {})).resolves.toEqual({
    state: 'accepted',
    fileId: 'saved',
    directory: '/',
  });
  expect(f.sendOidbPacket).toHaveBeenCalledOnce();
  const [pid, command, subCommand, body] = f.sendOidbPacket.mock.calls[0]!;
  expect([pid, command, subCommand]).toEqual([1, 0x6d9, 0]);
  expect(decode(TransGroupFile.reqSchema, body)).toEqual({
    transFile: { groupUin: 123n, appId: 7, busId, fileId: 'original' },
  });
  f.listing.mockResolvedValue({ ...listing, files: [{ ...file, expireTime: 0 }] });
  await expect(f.service.makePermanent(123, 'original', '/', () => {})).rejects.toThrow(
    '临时群文件',
  );
  expect(f.sendOidbPacket).toHaveBeenCalledOnce();
});

it('省略业务号的旧转存调用仍使用 102', () => {
  expect(TransGroupFile.serialize({ groupId: 123, fileId: 'old' })).toEqual({
    transFile: { groupUin: 123n, appId: 7, busId: 102, fileId: 'old' },
  });
});

it('目录确认转存后，重开账号仍能按当前群找到原文件 ID', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weq-group-file-transfers-'));
  try {
    const path = join(directory, 'transfers.json');
    const f = fixture(path);
    f.context.mockResolvedValue({ role: 'owner' });
    vi.spyOn(TransGroupFile, 'invoke').mockResolvedValue({ saveBusId: 104, saveFilePath: 'saved' });
    const file = {
      fileId: 'temporary',
      fileName: '测试',
      fileSize: 3221225472,
      busId: 104,
      expireTime: Math.ceil(Date.now() / 1000) + 3600,
      expireTimeKnown: true,
    } as GroupFileItem;
    const listing = { targetDirectory: '/', folders: [], files: [file] };
    f.listing.mockResolvedValueOnce(listing).mockResolvedValueOnce({
      ...listing,
      files: [{ ...file, fileId: 'saved', busId: 102, expireTime: 0 }],
    });
    const outcome = await f.service.makePermanent(123, 'temporary', '/', () => {});
    expect(outcome).toEqual({ state: 'accepted', fileId: 'saved', directory: '/' });
    const reopened = fixture(path).service;
    expect(reopened.originalFileId('123', 'saved')).toBe('temporary');
    expect(reopened.originalFileId('321', 'saved')).toBeUndefined();
    expect(reopened.originalFileId('123', 'different')).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('转存回执成功但目录只出现同名同尺寸的其他文件时保留未确认', async () => {
  const f = fixture();
  f.context.mockResolvedValue({ role: 'owner' });
  f.sendOidbPacket.mockResolvedValue(
    Buffer.from(
      encode(TransGroupFile.respSchema, { transFile: { saveBusId: 104, saveFilePath: 'saved' } }),
    ),
  );
  const file = {
    fileId: 'original',
    fileName: '测试',
    fileSize: 3221225472,
    busId: 104,
    expireTime: Math.ceil(Date.now() / 1000) + 3600,
    expireTimeKnown: true,
  } as GroupFileItem;
  f.listing
    .mockResolvedValueOnce({ targetDirectory: '/', folders: [], files: [file] })
    .mockResolvedValueOnce({
      targetDirectory: '/',
      folders: [],
      files: [{ ...file, fileId: 'different', busId: 102, expireTime: 0 }],
    });
  await expect(f.service.makePermanent(123, 'original', '/', () => {})).resolves.toEqual({
    state: 'unconfirmed',
    fileId: null,
    directory: null,
  });
  expect(f.sendOidbPacket).toHaveBeenCalledOnce();
});

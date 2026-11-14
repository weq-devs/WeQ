import type { AccountSession } from '@weq/account';
import { DeleteGroupFile, RenameGroupFile, MoveGroupFile, type GroupFileItem } from '@weq/protocol';
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

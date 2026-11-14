import { expect, it, vi } from 'vitest';
import { albumCapabilities } from '@weq/service/qq-permissions';
import { createQQActionsRouter, type QQActionServices } from '../src/main/ipc/routers/qq_actions';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
const target = { ...binding, groupId: 12345, albumId: 'album', title: '新名称' };
function fixture(operations: number[]) {
  const modify = vi.fn(async () => {});
  const remove = vi.fn(async () => {});
  const create = vi.fn(async () => ({ albumId: 'new' }));
  const rights = vi.fn(async () => ({ capabilities: albumCapabilities(operations) }));
  const uploadAuth = vi.fn(async () => ({ allowed: false }));
  const services = {
    accountConfig: { getRecord: () => ({ qqPid: 10 }) },
    accountWrite: { selfIdentity: () => ({ uin: '10001', uid: 'u_self' }) },
    groupInfo: { operationContext: async () => ({ role: 'owner' }) },
    groupAlbumMedia: { getMediaList: rights },
    webQuery: {
      getGroupAlbumList: async () => [{ id: 'album', createUin: 10001 }],
      getGroupAlbumDetails: async () => ({ privacy: 1 }),
      getGroupAlbumUploadPermission: uploadAuth,
      modifyGroupAlbum: modify,
      deleteGroupAlbum: remove,
      createGroupAlbum: create,
    },
  } as unknown as QQActionServices;
  return {
    caller: createQQActionsRouter(() => services).createCaller({}),
    rights,
    modify,
    remove,
    create,
    uploadAuth,
  };
}
it('相册创建者或群主身份不代替逐项能力；修改允许不代表允许删除', async () => {
  const f = fixture([2]);
  await expect(f.caller.albumManagement({ ...target, action: 'modify' })).resolves.toEqual({
    state: 'accepted',
  });
  expect(f.modify).toHaveBeenCalledOnce();
  await expect(f.caller.albumManagement({ ...target, action: 'delete' })).rejects.toThrow('权限');
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.rights).toHaveBeenCalledTimes(2);
});
it('提交时重新读取能力，编辑期间被撤权后不提交', async () => {
  const f = fixture([2]);
  await expect(f.caller.albumPermissions(target)).resolves.toMatchObject({ modify: true });
  f.rights.mockResolvedValue({ capabilities: albumCapabilities([]) });
  await expect(f.caller.albumManagement({ ...target, action: 'modify' })).rejects.toThrow('权限');
  expect(f.modify).not.toHaveBeenCalled();
});
it('群级新建使用已确认的官方 CGI 创建许可，不套单册修改或上传能力', async () => {
  const f = fixture([2, 3, 6]);
  await expect(f.caller.albumManagement({ ...target, action: 'create' })).rejects.toThrow('创建');
  expect(f.create).not.toHaveBeenCalled();
  f.uploadAuth.mockResolvedValue({ allowed: true });
  await expect(f.caller.albumManagement({ ...target, action: 'create' })).resolves.toEqual({
    state: 'accepted',
  });
  expect(f.create).toHaveBeenCalledOnce();
});

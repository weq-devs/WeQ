import { expect, it, vi } from 'vitest';
import { createQQActionsRouter, type QQActionServices } from '../src/main/ipc/routers/qq_actions';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
const input = {
  ...binding,
  groupId: 12345,
  albumId: 'album',
  mediaId: 'photo',
  batchId: '1',
  action: 'delete' as const,
};
function fixture(role: 'member' | 'admin', uploader: string) {
  const remove = vi.fn(async () => {});
  const list = vi.fn(async () => ({
    mediaList: [{ image: { lloc: 'photo' }, batchId: '1', uploader }],
    nextAttachInfo: '',
  }));
  const services = {
    accountConfig: { getRecord: () => ({ qqPid: 10 }) },
    accountWrite: { selfIdentity: () => ({ uin: '10001' }) },
    groupInfo: { listGroupDirectory: async () => [{ groupCode: '12345', role }] },
    groupAlbumMedia: { deleteMedia: remove, getMediaList: list },
  } as unknown as QQActionServices;
  return { caller: createQQActionsRouter(() => services).createCaller({}), remove, list };
}
it('普通成员不能靠伪造上传者字段删除他人媒体，后端不发删除请求', async () => {
  const test = fixture('member', '10002');
  await expect(test.caller.albumMedia({ ...input, uploaderUin: '10001' })).rejects.toThrow(
    '上传者',
  );
  expect(test.remove).not.toHaveBeenCalled();
});
it('本人上传的媒体和管理员操作保留，管理员不遍历媒体查上传者', async () => {
  const own = fixture('member', '10001');
  await expect(own.caller.albumMedia(input)).resolves.toEqual({ state: 'accepted' });
  expect(own.remove).toHaveBeenCalledOnce();
  const admin = fixture('admin', '10002');
  await expect(admin.caller.albumMedia(input)).resolves.toEqual({ state: 'accepted' });
  expect(admin.list).not.toHaveBeenCalled();
});
it('同照片键的其他批次不能用于授权，继续读取准确批次后再判定', async () => {
  const test = fixture('member', '10001');
  test.list
    .mockResolvedValueOnce({
      mediaList: [{ image: { lloc: 'photo' }, batchId: '2', uploader: '10001' }],
      nextAttachInfo: 'next',
    })
    .mockResolvedValueOnce({
      mediaList: [{ image: { lloc: 'photo' }, batchId: '1', uploader: '10002' }],
      nextAttachInfo: '',
    });
  await expect(test.caller.albumMedia(input)).rejects.toThrow('上传者');
  expect(test.list).toHaveBeenNthCalledWith(2, '12345', 'album', 'next');
  expect(test.remove).not.toHaveBeenCalled();
});

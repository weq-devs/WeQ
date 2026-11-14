import type { AccountSession } from '@weq/account';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetAlbumMediaList } from '@weq/protocol';
import { GroupAlbumMediaService } from '../src/account/group_album_media';
import { albumCapabilities, albumMediaDeleteAllowed } from '../src/common/qq_permissions';

afterEach(() => vi.restoreAllMocks());
describe('群相册逐项能力', () => {
  it('编号是列表不是位掩码，未知返回与明确空列表分开', () => {
    expect(albumCapabilities(null)).toBeNull();
    expect(albumCapabilities([])?.upload).toBe(false);
    expect(albumCapabilities([3])).toMatchObject({
      create: false,
      modify: false,
      upload: true,
      deleteAlbum: false,
    });
    expect(albumCapabilities([1, 2, 4, 5, 6])).toMatchObject({
      create: true,
      modify: true,
      upload: false,
      deleteMedia: true,
      top: true,
      deleteAlbum: true,
    });
  });
  it('媒体删除遵循 Android 入口的 DELETEALBUM 或可信上传者，不误套同名编号', () => {
    expect(albumMediaDeleteAllowed(albumCapabilities([4]), false)).toBe(false);
    expect(albumMediaDeleteAllowed(albumCapabilities([6]), false)).toBe(true);
    expect(albumMediaDeleteAllowed(null, true)).toBe(true);
  });
  it('媒体列表序号不是错误码，服务端逐相册权限不被身份替换', async () => {
    const invoke = vi.spyOn(GetAlbumMediaList, 'invoke').mockResolvedValue({
      field1: 42,
      result: 0,
      data: {
        right: { operations: [2, 3] },
        mediaList: [],
      },
    });
    const service = new GroupAlbumMediaService(
      { sendPacket: vi.fn() },
      {} as AccountSession,
      () => 1,
    );
    expect((await service.getMediaList('123', 'album')).capabilities).toMatchObject({
      modify: true,
      upload: true,
      deleteAlbum: false,
    });
    invoke.mockResolvedValue({ result: 5 });
    await expect(service.getMediaList('123', 'album')).rejects.toThrow('retCode 5');
    invoke.mockResolvedValue({ data: {} });
    expect((await service.getMediaList('123', 'album')).capabilities).toBeNull();
    invoke.mockResolvedValue({
      data: { albumInfo: { albumId: 'other' }, right: { operations: [6] } },
    });
    await expect(service.getMediaList('123', 'album')).rejects.toThrow('目标相册不一致');
  });
});

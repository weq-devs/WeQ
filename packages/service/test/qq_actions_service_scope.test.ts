import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import {
  CommentGroupAlbumMedia,
  GetGroupAlbumFeedDetail,
  MoveCustomFace,
  OrderCustomFace,
  decode,
} from '@weq/protocol';
import { EmojiService } from '../src/account/emoji';
import { GroupAlbumMediaService } from '../src/account/group_album_media';

afterEach(() => vi.restoreAllMocks());
const session = { context: { uin: 10001n } } as unknown as AccountSession;
const favoriteA = '10001_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0';
const favoriteB = '10001_0_0_0_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB_0_0';
function emojiFixture() {
  const sendOidbPacket = vi.fn(async (..._args: unknown[]) => Buffer.alloc(0));
  const svc = new EmojiService(session, {} as Platform, {
    nt: {
      sendOidbPacket,
      sendPacket: vi.fn(async () => {
        throw new Error('不允许联网');
      }),
    },
    resolvePid: () => 101,
  });
  vi.spyOn(svc, 'fetchOnlineFavoriteIds').mockResolvedValue([favoriteA, favoriteB]);
  return { svc, sendOidbPacket };
}
it('收藏排序先移动再上传完整顺序，不丢掉其他收藏', async () => {
  const { svc, sendOidbPacket } = emojiFixture();
  await svc.moveFavorite(favoriteB, 1);
  expect(sendOidbPacket.mock.calls.map((c) => c[1])).toEqual([
    OrderCustomFace.command,
    MoveCustomFace.command,
  ]);
  const payload = decode(MoveCustomFace.reqSchema, sendOidbPacket.mock.calls[1]![3] as Uint8Array);
  expect((payload.emojis as Array<{ emojiId: string }>).map((e) => e.emojiId)).toEqual([
    favoriteB,
    favoriteA,
  ]);
});
it('收藏排序的列表读取后或两次写入之间失效，不继续下一阶段', async () => {
  const first = emojiFixture();
  await expect(
    first.svc.moveFavorite(favoriteA, 2, () => {
      throw new Error('账号改变');
    }),
  ).rejects.toThrow('账号改变');
  expect(first.sendOidbPacket).not.toHaveBeenCalled();
  const second = emojiFixture();
  let stage = 0;
  await expect(
    second.svc.moveFavorite(favoriteA, 2, () => {
      if (++stage === 2) throw new Error('运行时改变');
    }),
  ).rejects.toThrow('运行时改变');
  expect(second.sendOidbPacket).toHaveBeenCalledOnce();
});
it('相册评论保留详情的原始 cell，不由界面重建', async () => {
  const cells = {
    cellCommon: new Uint8Array([1, 2]),
    cellUserInfo: new Uint8Array([3]),
    cellMedia: new Uint8Array([4]),
    feedId: 'feed-a',
    ownerUin: '10002',
  };
  vi.spyOn(GetGroupAlbumFeedDetail, 'invoke').mockResolvedValue(cells);
  const comment = vi
    .spyOn(CommentGroupAlbumMedia, 'invoke')
    .mockResolvedValue({ id: 'comment-a', clientKey: 'synthetic', time: 1 });
  const svc = new GroupAlbumMediaService(
    {
      sendPacket: vi.fn(async () => {
        throw new Error('不允许联网');
      }),
    },
    session,
    () => 101,
  );
  await svc.comment('123', 'album-a', '42', 'media-a', '10001', '评论', () => {});
  expect(comment).toHaveBeenCalledWith(
    expect.anything(),
    101,
    expect.objectContaining({ cells, selfUin: '10001', content: '评论' }),
  );
  expect(comment.mock.calls[0]![2].cells.cellCommon).toBe(cells.cellCommon);
});
it('相册详情读取后账号或 PID 失效，不能评论旧媒体', async () => {
  let pid = 101;
  vi.spyOn(GetGroupAlbumFeedDetail, 'invoke').mockImplementation(async () => {
    pid = 102;
    return { cellCommon: new Uint8Array([1]), feedId: 'feed-a', ownerUin: '10002' };
  });
  const comment = vi
    .spyOn(CommentGroupAlbumMedia, 'invoke')
    .mockResolvedValue({ id: 'comment-a', clientKey: 'synthetic', time: 1 });
  const svc = new GroupAlbumMediaService(
    {
      sendPacket: vi.fn(async () => {
        throw new Error('不允许联网');
      }),
    },
    session,
    () => pid,
  );
  await expect(
    svc.comment('123', 'album-a', '42', 'media-a', '10001', '不发送', () => {}),
  ).rejects.toThrow('运行时');
  expect(comment).not.toHaveBeenCalled();
});

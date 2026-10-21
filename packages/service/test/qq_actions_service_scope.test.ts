import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import {
  CommentGroupAlbumMedia,
  GetGroupAlbumFeedDetail,
  MoveCustomFace,
  OrderCustomFace,
  FetchCustomFaceDetail,
  parseCustomFaceId,
  decode,
  encode,
} from '@weq/protocol';
import { EmojiService, FAVORITE_EMOJI_DETAIL_BATCH_SIZE } from '../src/account/emoji';
import { GroupAlbumMediaService } from '../src/account/group_album_media';

afterEach(() => vi.restoreAllMocks());
const session = { context: { uin: 10001n } } as unknown as AccountSession;
const favoriteA = '10001_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0';
const favoriteB = '10001_0_0_0_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB_0_0';
function emojiFixture() {
  let pid = 101;
  const sendOidbPacket = vi.fn(async (..._args: unknown[]) => Buffer.alloc(0));
  const svc = new EmojiService(session, {} as Platform, {
    nt: {
      sendOidbPacket,
      sendPacket: vi.fn(async () => {
        throw new Error('不允许联网');
      }),
    },
    resolvePid: () => pid,
  });
  vi.spyOn(svc, 'fetchOnlineFavoriteIds').mockResolvedValue([favoriteA, favoriteB]);
  return {
    svc,
    sendOidbPacket,
    changePid: () => {
      pid++;
    },
  };
}

function favoriteRefs(count: number) {
  return Array.from({ length: count }, (_, index) =>
    parseCustomFaceId(`10001_0_0_0_${index.toString(16).padStart(32, '0').toUpperCase()}_0_0`),
  );
}
function detailsResponse(body: Uint8Array) {
  const request = decode(FetchCustomFaceDetail.reqSchema, body);
  const refs = request.emojis as Array<{ emojiId: string; md5: string }>;
  return Buffer.from(
    encode(FetchCustomFaceDetail.respSchema, {
      retCode: 0,
      entries: refs.map((emoji) => ({ emoji, desc: '合成备注' })),
    }),
  );
}

it('空详情和重复请求不发包，也不会占住后续排序的串行槽', async () => {
  const f = emojiFixture();
  await expect(f.svc.fetchOnlineFavoriteDetails([])).resolves.toEqual([]);
  const ref = parseCustomFaceId(favoriteA);
  await expect(f.svc.fetchOnlineFavoriteDetails([ref, ref])).rejects.toThrow('重复');
  expect(f.sendOidbPacket).not.toHaveBeenCalled();
  await f.svc.moveFavorite(favoriteB, 1);
  expect(f.sendOidbPacket.mock.calls.map((call) => call[1])).toEqual([
    OrderCustomFace.command,
    MoveCustomFace.command,
  ]);
});

it('收藏详情按已验证预算分批读取全部条目，不截断或丢弃末批', async () => {
  const f = emojiFixture();
  const refs = favoriteRefs(FAVORITE_EMOJI_DETAIL_BATCH_SIZE * 2 + 1);
  f.sendOidbPacket.mockImplementation(async (...args) => detailsResponse(args[3] as Uint8Array));
  const details = await f.svc.fetchOnlineFavoriteDetails(refs);
  expect(f.sendOidbPacket).toHaveBeenCalledTimes(3);
  const sizes = f.sendOidbPacket.mock.calls.map(
    (call) =>
      (decode(FetchCustomFaceDetail.reqSchema, call[3] as Uint8Array).emojis as unknown[]).length,
  );
  expect(sizes).toEqual([FAVORITE_EMOJI_DETAIL_BATCH_SIZE, FAVORITE_EMOJI_DETAIL_BATCH_SIZE, 1]);
  expect(details.map((item) => item.emojiId)).toEqual(refs.map((item) => item.emojiId));
});

it('某批返回非本批表情时停止，不能混入先前批次或返回半份成功', async () => {
  const f = emojiFixture();
  const refs = favoriteRefs(FAVORITE_EMOJI_DETAIL_BATCH_SIZE * 2 + 1);
  f.sendOidbPacket.mockImplementation(async (...args) => detailsResponse(args[3] as Uint8Array));
  f.sendOidbPacket.mockImplementationOnce(async (...args) =>
    detailsResponse(args[3] as Uint8Array),
  );
  f.sendOidbPacket.mockImplementationOnce(async () =>
    Buffer.from(
      encode(FetchCustomFaceDetail.respSchema, {
        retCode: 0,
        entries: [{ emoji: refs[0], desc: '重复的旧批次' }],
      }),
    ),
  );
  await expect(f.svc.fetchOnlineFavoriteDetails(refs)).rejects.toThrow('批次');
  expect(f.sendOidbPacket).toHaveBeenCalledTimes(2);
});

it('跨批等待中运行态失效，不再查询后续批次', async () => {
  const f = emojiFixture();
  f.sendOidbPacket.mockImplementationOnce(async (...args) => {
    f.changePid();
    return detailsResponse(args[3] as Uint8Array);
  });
  await expect(
    f.svc.fetchOnlineFavoriteDetails(favoriteRefs(FAVORITE_EMOJI_DETAIL_BATCH_SIZE + 1)),
  ).rejects.toThrow('运行时');
  expect(f.sendOidbPacket).toHaveBeenCalledOnce();
});

it('详情读取不能夹进移动指令与完整顺序上传之间', async () => {
  const f = emojiFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.sendOidbPacket.mockImplementationOnce(async () => {
    await gate;
    return Buffer.alloc(0);
  });
  const move = f.svc.moveFavorite(favoriteB, 1);
  await vi.waitFor(() => expect(f.sendOidbPacket).toHaveBeenCalledOnce());
  const refs = [favoriteA, favoriteB].map(parseCustomFaceId);
  const read = f.svc.fetchOnlineFavoriteDetails(refs);
  refs.reverse();
  const countBeforeRelease = f.sendOidbPacket.mock.calls.length;
  release();
  await Promise.all([move, read]);
  expect(countBeforeRelease).toBe(1);
  expect(f.sendOidbPacket.mock.calls.map((call) => call[1])).toEqual([
    OrderCustomFace.command,
    MoveCustomFace.command,
    FetchCustomFaceDetail.command,
  ]);
  const body = decode(
    FetchCustomFaceDetail.reqSchema,
    f.sendOidbPacket.mock.calls[2]![3] as Uint8Array,
  );
  expect((body.emojis as Array<{ emojiId: string }>).map((item) => item.emojiId)).toEqual([
    favoriteA,
    favoriteB,
  ]);
});

it('详情读取失败也释放串行槽，后续显式排序仍可完成', async () => {
  const f = emojiFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.sendOidbPacket.mockImplementationOnce(async () => {
    await gate;
    throw new Error('合成读取失败');
  });
  const read = f.svc.fetchOnlineFavoriteDetails([favoriteA, favoriteB].map(parseCustomFaceId));
  await vi.waitFor(() => expect(f.sendOidbPacket).toHaveBeenCalledOnce());
  const move = f.svc.moveFavorite(favoriteB, 1);
  await Promise.resolve();
  const countBeforeRelease = f.sendOidbPacket.mock.calls.length;
  const failed = expect(read).rejects.toThrow('合成读取失败');
  release();
  await failed;
  await move;
  expect(countBeforeRelease).toBe(1);
  expect(f.sendOidbPacket.mock.calls.map((call) => call[1])).toEqual([
    FetchCustomFaceDetail.command,
    OrderCustomFace.command,
    MoveCustomFace.command,
  ]);
});

it('排队等待期间 PID 改变，旧详情和后续排序包都不转投新进程', async () => {
  const f = emojiFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.sendOidbPacket.mockImplementationOnce(async () => {
    await gate;
    return Buffer.alloc(0);
  });
  const move = f.svc.moveFavorite(favoriteB, 1);
  await vi.waitFor(() => expect(f.sendOidbPacket).toHaveBeenCalledOnce());
  const read = f.svc.fetchOnlineFavoriteDetails([favoriteA, favoriteB].map(parseCustomFaceId));
  f.changePid();
  const moved = expect(move).rejects.toThrow('运行时');
  const readBack = expect(read).rejects.toThrow('运行时');
  release();
  await Promise.all([moved, readBack]);
  expect(f.sendOidbPacket).toHaveBeenCalledOnce();
});

it('详情回包返回时 PID 已改变，不把旧运行态的结果交给界面', async () => {
  const f = emojiFixture();
  f.sendOidbPacket.mockImplementationOnce(async () => {
    f.changePid();
    return Buffer.alloc(0);
  });
  await expect(
    f.svc.fetchOnlineFavoriteDetails([favoriteA].map(parseCustomFaceId)),
  ).rejects.toThrow('运行时');
  expect(f.sendOidbPacket).toHaveBeenCalledOnce();
});
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

// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSolidPng } from '@weq/protocol';
import { readFavoriteEmojiMedia } from '../src/main/ipc/routers/favorite_emoji_media';
import { createQQActionsRouter, type QQActionServices } from '../src/main/ipc/routers/qq_actions';

const media = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('../src/main/media_protocol', () => ({ handleMediaRequest: media.handle }));
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
const png = Buffer.from(makeSolidPng(2, 2, 40, 100, 160, 255));
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
afterEach(() => vi.resetAllMocks());

describe('聊天表情原文件读取', () => {
  it.each(['weq-media://pic?token=a&v=thumb', '/_media/mface?pack=1&hash=abc'])(
    '复用 %s 协议，强制原图并逐字节保留动图',
    async (url) => {
      media.handle.mockResolvedValue(new Response(gif));
      const current = vi.fn();
      expect(await readFavoriteEmojiMedia(url, current)).toEqual(gif);
      const request = media.handle.mock.calls[0]![0] as Request;
      expect(new URL(request.url).searchParams.get('v')).toBe('original');
      expect(media.handle.mock.calls[0]![1]).toBe(current);
      expect(current).toHaveBeenCalled();
    },
  );

  it.each([
    'https://example.com/image.png',
    'file:///private/image.png',
    'weq-media://localfile?path=/private/image.png',
    '/_asset/emoji/face.png',
    'weq-media://pic/other',
    'weq-media://user:pass@pic',
  ])('不把 %s 当作聊天表情源', async (url) => {
    await expect(readFavoriteEmojiMedia(url, () => {})).rejects.toThrow();
    expect(media.handle).not.toHaveBeenCalled();
  });

  it.each([
    () => new Response('missing', { status: 404 }),
    () => new Response(png, { status: 206 }),
    () => new Response('not an image'),
    () => new Response(new Uint8Array()),
    () => new Response(png, { headers: { 'content-length': String(21 * 1024 * 1024) } }),
    () => new Response(new Uint8Array(20 * 1024 * 1024 + 1)),
  ])('拒绝失败、空、无效或超限原件', async (response) => {
    media.handle.mockResolvedValue(response());
    await expect(readFavoriteEmojiMedia('weq-media://pic?token=a', () => {})).rejects.toThrow();
  });

  it('读取期间切换账号不返回旧字节', async () => {
    let active = true;
    media.handle.mockImplementation(async () => {
      active = false;
      return new Response(png);
    });
    await expect(
      readFavoriteEmojiMedia('weq-media://pic?token=a', () => {
        if (!active) throw new Error('账号已切换');
      }),
    ).rejects.toThrow('账号已切换');
  });
});

describe('添加聊天表情路由', () => {
  function fixture() {
    let active = true;
    const record = { qqPid: 101 };
    const emojiId = `10001_0_0_0_${createHash('md5').update(png).digest('hex').toUpperCase()}_0_0`;
    const emoji = {
      fetchOnlineFavoriteIds: vi.fn(async (): Promise<string[]> => []),
      addFavorite: vi.fn(async () => emojiId),
    };
    const services = {
      accountConfig: { getRecord: () => record },
      emoji,
    } as unknown as QQActionServices;
    const caller = createQQActionsRouter((input) => {
      if (!active || input.expectedAccountConfigId !== binding.expectedAccountConfigId)
        throw new Error('账号已切换');
      return services;
    }).createCaller({});
    media.handle.mockImplementation(async () => new Response(png));
    return {
      caller,
      emoji,
      emojiId,
      record,
      switch: () => {
        active = false;
      },
    };
  }

  it('上传原字节并返回表情 ID，提供在线读回接口', async () => {
    const f = fixture();
    const result = await f.caller.favoriteFromMedia({ ...binding, url: 'weq-media://pic?token=a' });
    expect(result).toEqual({ state: 'accepted', emojiId: f.emojiId });
    expect(f.emoji.addFavorite).toHaveBeenCalledWith(png, undefined, expect.any(Function));
    f.emoji.fetchOnlineFavoriteIds.mockResolvedValue([f.emojiId]);
    expect(await f.caller.favoriteIds(binding)).toEqual([f.emojiId]);
  });

  it('同图已存在时返回已有 ID，不再上传', async () => {
    const f = fixture();
    f.emoji.fetchOnlineFavoriteIds.mockResolvedValue([f.emojiId]);
    expect(
      (await f.caller.favoriteFromMedia({ ...binding, url: '/_media/pic?token=a' })).emojiId,
    ).toBe(f.emojiId);
    expect(f.emoji.addFavorite).not.toHaveBeenCalled();
  });

  it.each(['source', 'pid'] as const)('准备期间 %s 改变后不上传', async (change) => {
    const f = fixture();
    f.emoji.fetchOnlineFavoriteIds.mockImplementation(async () => {
      if (change === 'source') f.switch();
      else f.record.qqPid++;
      return [];
    });
    await expect(
      f.caller.favoriteFromMedia({ ...binding, url: 'weq-media://pic?token=a' }),
    ).rejects.toThrow();
    expect(f.emoji.addFavorite).not.toHaveBeenCalled();
  });

  it('原件不可用时不上传；失败后仍可重试', async () => {
    const f = fixture();
    media.handle.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(
      f.caller.favoriteFromMedia({ ...binding, url: 'weq-media://pic?token=a' }),
    ).rejects.toThrow('原文件');
    expect(f.emoji.addFavorite).not.toHaveBeenCalled();
    await f.caller.favoriteFromMedia({ ...binding, url: 'weq-media://pic?token=a' });
    expect(f.emoji.addFavorite).toHaveBeenCalledOnce();
  });
});

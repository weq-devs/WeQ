import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { makeSolidPng } from '@weq/protocol';
import {
  exportOnlineFavoriteEmojiBundle,
  favoriteEmojiOriginalUrl,
} from '../src/account/favorite_emoji_export';
import {
  readFavoriteEmojiBundle,
  FAVORITE_EMOJI_MAX_ITEMS,
} from '../src/account/favorite_emoji_bundle';

const bytes = Buffer.from(makeSolidPng(2, 3, [10, 20, 30]));
const hash = createHash('md5').update(bytes).digest('hex');
const emojiId = `10001_0_0_0_${hash.toUpperCase()}_0_0`;
function fixture() {
  return {
    port: {
      fetchOnlineFavoriteIds: vi.fn(async () => [emojiId]),
      fetchOnlineFavoriteDetails: vi.fn(async () => [{ emojiId, desc: '原始备注' }]),
      listFavEmojiRows: vi.fn(async () => [
        {
          hash,
          oriPath: '/synthetic/original',
          thumbPath: '/synthetic/thumb',
          remoteUrl: 'https://gchat.qpic.cn/synthetic-original',
        },
        { hash: 'a'.repeat(32), oriPath: '/synthetic/cache-only', thumbPath: '', remoteUrl: '' },
      ]),
    },
    options: {
      current: () => {},
      readLocal: vi.fn(async (_path: string) => bytes),
      readRemote: vi.fn(async (_url: string) => bytes),
    },
  };
}

describe('在线收藏包导出', () => {
  it('超过单包条目预算时先拒绝，不启动分批详情或原图读取', async () => {
    const { port, options } = fixture();
    port.fetchOnlineFavoriteIds.mockResolvedValue(
      Array.from(
        { length: FAVORITE_EMOJI_MAX_ITEMS + 1 },
        (_, index) => `10001_0_0_0_${index.toString(16).padStart(32, '0')}_0_0`,
      ),
    );
    await expect(exportOnlineFavoriteEmojiBundle(port, options)).rejects.toThrow('单包上限');
    expect(port.fetchOnlineFavoriteDetails).not.toHaveBeenCalled();
    expect(port.listFavEmojiRows).not.toHaveBeenCalled();
    expect(options.readLocal).not.toHaveBeenCalled();
  });
  it('在线列表决定内容与顺序，元数据来自对应详情，缓存散图不混入', async () => {
    const { port, options } = fixture();
    const result = await exportOnlineFavoriteEmojiBundle(port, options);
    expect(result).toMatchObject({ total: 1, written: 1 });
    expect(readFavoriteEmojiBundle(result.archive)[0]).toMatchObject({
      emojiId,
      position: 1,
      description: '原始备注',
    });
    expect(options.readLocal.mock.calls).toEqual([['/synthetic/original', undefined]]);
    expect(options.readRemote).not.toHaveBeenCalled();
  });
  it('本地原图错误时尝试已登记的远端原图，不导出缩略图', async () => {
    const { port, options } = fixture();
    options.readLocal.mockResolvedValue(Buffer.from('wrong bytes'));
    const result = await exportOnlineFavoriteEmojiBundle(port, options);
    expect(result.written).toBe(1);
    expect(options.readRemote).toHaveBeenCalledWith(
      'https://gchat.qpic.cn/synthetic-original',
      undefined,
    );
    expect(options.readLocal.mock.calls.some(([path]) => path.includes('thumb'))).toBe(false);
  });
  it('原图不可用时留下失败条目，不泄漏本地路径或签名 URL', async () => {
    const { port, options } = fixture();
    options.readLocal.mockRejectedValue(new Error('private local path'));
    options.readRemote.mockRejectedValue(new Error('private token'));
    const result = await exportOnlineFavoriteEmojiBundle(port, options);
    expect(result).toMatchObject({ total: 1, written: 0 });
    expect(readFavoriteEmojiBundle(result.archive)[0]?.issue).toContain('原图');
    expect(result.archive.includes(Buffer.from('private'))).toBe(false);
  });
  it('缺少对应详情不默认为空备注，账号变更或取消时不继续读图', async () => {
    const { port, options } = fixture();
    port.fetchOnlineFavoriteDetails.mockResolvedValueOnce([]);
    await expect(exportOnlineFavoriteEmojiBundle(port, options)).rejects.toThrow('备注');
    expect(options.readLocal).not.toHaveBeenCalled();
    let changed = false;
    port.fetchOnlineFavoriteDetails.mockImplementationOnce(async () => {
      changed = true;
      return [{ emojiId, desc: '' }];
    });
    await expect(
      exportOnlineFavoriteEmojiBundle(port, {
        ...options,
        current: () => {
          if (changed) throw new Error('账号已切换');
        },
      }),
    ).rejects.toThrow('切换');
    expect(port.listFavEmojiRows).not.toHaveBeenCalled();
    const abort = new AbortController();
    abort.abort();
    await expect(
      exportOnlineFavoriteEmojiBundle(port, { ...options, signal: abort.signal }),
    ).rejects.toThrow();
    expect(options.readLocal).not.toHaveBeenCalled();
  });
  it('拒绝非 QQ 原图主机、凭据 URL 与非默认端口', () => {
    for (const url of [
      'file:///private/path',
      'http://127.0.0.1/image',
      'https://gchat.qpic.cn.evil.invalid/a',
      'https://user:secret@gchat.qpic.cn/a',
      'https://gchat.qpic.cn:8443/a',
    ])
      expect(favoriteEmojiOriginalUrl(url)).toBeNull();
    expect(favoriteEmojiOriginalUrl('https://gchat.qpic.cn/a')).toBe('https://gchat.qpic.cn/a');
  });
});

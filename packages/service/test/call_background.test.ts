/**
 * 通话背景的取用策略。
 *
 * 核心是一条**不该联网的时候绝不联网**的判据：通话是实时交互，为了背景图去等一次
 * p_skey + CDN 往返会直接拖慢拨号。这里用假 session / 假 config 把三种情形钉死，
 * 不碰真 QQ、不联网。
 */

import { describe, expect, it, vi } from 'vitest';

const fetchHomeDress = vi.fn();

vi.mock('../src/account/home_dress', () => ({
  fetchHomeDress: (...args: unknown[]) => fetchHomeDress(...args),
}));

const { ensureCallBackground } = await import('../src/account/call_background');

type Record = Record<string, unknown> | null;

function fakeConfig(record: Record) {
  return {
    getRecord: () => record,
    setHomeDress: vi.fn((next: unknown) => {
      record = next as Record;
    }),
    clearLoginPskey: vi.fn(),
  };
}

const session = { context: { uin: '1707889225' } } as never;
const nt = {} as never;

describe('ensureCallBackground', () => {
  it('快照里已查过这一项 → 直接用，不联网', async () => {
    fetchHomeDress.mockReset();
    const config = fakeConfig({
      homeDress: {
        widgetUrl: '',
        cardUrl: '',
        cardVideoUrl: '',
        screenUrl: '',
        tags: [],
        callBgUrl: 'https://x/image.jpg',
        callBgVideoUrl: 'https://x/media.mp4',
        callBgId: 41136,
        callBgName: '星雨戏水喵',
        callBgCheckedAt: 1_700_000_000_000,
      },
    });

    const bg = await ensureCallBackground(nt, session, config as never, 1);
    expect(bg).toEqual({
      imageUrl: 'https://x/image.jpg',
      videoUrl: 'https://x/media.mp4',
      itemId: 41136,
      name: '星雨戏水喵',
    });
    expect(fetchHomeDress).not.toHaveBeenCalled();
  });

  it('查过但为空（用户没设）→ 同样不联网', async () => {
    fetchHomeDress.mockReset();
    const config = fakeConfig({
      homeDress: {
        widgetUrl: '',
        cardUrl: '',
        cardVideoUrl: '',
        screenUrl: '',
        tags: [],
        // 空 URL 但有时刻 —— 这是「查过了、确实没设」，不是「没查过」。
        callBgCheckedAt: 1_700_000_000_000,
      },
    });

    const bg = await ensureCallBackground(nt, session, config as never, 1);
    expect(bg).toEqual({ imageUrl: '', videoUrl: '', itemId: 0, name: '' });
    expect(fetchHomeDress).not.toHaveBeenCalled();
  });

  it('老快照没查过这一项 → 查一次并写回', async () => {
    fetchHomeDress.mockReset();
    fetchHomeDress.mockResolvedValue({
      widgetUrl: '',
      cardUrl: '',
      cardVideoUrl: '',
      screenUrl: '',
      tags: [],
      callBgUrl: 'https://x/a.jpg',
      callBgVideoUrl: 'https://x/a.mp4',
      callBgId: 41144,
      callBgName: '冬夜冰透喵',
      callBgCheckedAt: 1_700_000_000_001,
    });
    const config = fakeConfig({
      // 只有老字段，没有 callBgCheckedAt。
      homeDress: { widgetUrl: '', cardUrl: '', cardVideoUrl: '', screenUrl: '', tags: [] },
    });

    const bg = await ensureCallBackground(nt, session, config as never, 1);
    expect(fetchHomeDress).toHaveBeenCalledTimes(1);
    expect(bg.itemId).toBe(41144);
    expect(bg.videoUrl).toBe('https://x/a.mp4');
    expect(config.setHomeDress).toHaveBeenCalledWith(
      expect.objectContaining({ callBgCheckedAt: 1_700_000_000_001 }),
    );
  });

  it('refresh 明确要求重查时忽略缓存', async () => {
    fetchHomeDress.mockReset();
    fetchHomeDress.mockResolvedValue({
      widgetUrl: '',
      cardUrl: '',
      cardVideoUrl: '',
      screenUrl: '',
      tags: [],
      callBgCheckedAt: 1_700_000_000_002,
    });
    const config = fakeConfig({
      homeDress: {
        widgetUrl: '',
        cardUrl: '',
        cardVideoUrl: '',
        screenUrl: '',
        tags: [],
        callBgUrl: 'https://old/x.jpg',
        callBgCheckedAt: 1_700_000_000_000,
      },
    });

    await ensureCallBackground(nt, session, config as never, 1, { refresh: true });
    expect(fetchHomeDress).toHaveBeenCalledTimes(1);
  });

  it('查失败不抛错 —— 通话不能因为背景图打不开而拨不出去', async () => {
    fetchHomeDress.mockReset();
    fetchHomeDress.mockRejectedValue(new Error('pskey 过期'));
    const config = fakeConfig({
      homeDress: { widgetUrl: '', cardUrl: '', cardVideoUrl: '', screenUrl: '', tags: [] },
    });

    await expect(ensureCallBackground(nt, session, config as never, 1)).resolves.toEqual({
      imageUrl: '',
      videoUrl: '',
      itemId: 0,
      name: '',
    });
  });

  it('把登录时的 p_skey 传给抓取，并把失效域清掉', async () => {
    fetchHomeDress.mockReset();
    fetchHomeDress.mockResolvedValue({
      widgetUrl: '',
      cardUrl: '',
      cardVideoUrl: '',
      screenUrl: '',
      tags: [],
      callBgCheckedAt: 1,
    });
    const config = fakeConfig({
      loginPskey: { 'vip.qq.com': 'seed' },
      homeDress: { widgetUrl: '', cardUrl: '', cardVideoUrl: '', screenUrl: '', tags: [] },
    });

    await ensureCallBackground(nt, session, config as never, 1);
    // 第 4 个参数是 seed，第 5 个是失效回调
    expect(fetchHomeDress.mock.calls[0]![3]).toEqual({ 'vip.qq.com': 'seed' });
    const onInvalidated = fetchHomeDress.mock.calls[0]![4] as (d: string) => void;
    onInvalidated('vip.qq.com');
    expect(config.clearLoginPskey).toHaveBeenCalledWith('vip.qq.com');
  });
});

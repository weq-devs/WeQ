/**
 * club.vip 会员接口的离线单测。
 *
 * 全部 mock 全局 `fetch`，样本按抓包结构脱敏构造；不联网、不碰真实账号数据。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeBkn, WebAuthError } from '../src/account/web/credential';
import { fetchVipInfo, normalizeVipPayload, parseExpireTime } from '../src/account/web/vip_info';

const credential = { uin: '10001', skey: 'synthetic-skey', pskey: 'synthetic-pskey' };

function response(data: Record<string, unknown> | undefined, code = 0) {
  return { code, data, message: code === 0 ? 'OK' : 'failed' };
}

/** 抓包里「超会 + 大会员、非年费」的脱敏形状。 */
const SVIP_BVIP = {
  uin: 10001,
  clubStatus: 3,
  isVip: true,
  isSvip: true,
  isBvip: true,
  isVipYear: false,
  isBvipYear: false,
  vipLevel: 4,
  bvipLevel: 8,
  club_end_timestamp: 1794988324,
  superclub_end_timestamp: 1794988400,
  sVipExpireTime: '2026-11-18 15:52:04',
  sSVipExpireTime: '2026-11-18 15:52:04',
  sYearExpireTime: '',
};

afterEach(() => vi.unstubAllGlobals());

describe('会员接口归一化', () => {
  it('大会员优先于超会，等级/到期时间取对应档位', () => {
    expect(normalizeVipPayload(SVIP_BVIP, 1000)).toEqual({
      tier: 'bvip',
      year: false,
      level: 8,
      expireAt: 1794988400,
      fetchedAt: 1000,
    });
  });

  it('只有超会时取超会档位', () => {
    expect(normalizeVipPayload({ ...SVIP_BVIP, isBvip: false, bvipLevel: 0 }, 1)).toMatchObject({
      tier: 'svip',
      level: 4,
      expireAt: 1794988324,
    });
  });

  it('只有普通会员时取 vip 档位（该档没有独立等级字段）', () => {
    expect(
      normalizeVipPayload({ isVip: true, isSvip: false, isBvip: false, vipLevel: 2 }, 1),
    ).toMatchObject({ tier: 'vip', level: 2 });
  });

  it('年费标记按档位取：大会员看 isBvipYear，其余看 isVipYear', () => {
    expect(normalizeVipPayload({ ...SVIP_BVIP, isBvipYear: true }, 1)?.year).toBe(true);
    expect(normalizeVipPayload({ isVip: true, isSvip: true, isVipYear: true }, 1)?.year).toBe(true);
    expect(normalizeVipPayload({ isVip: true, isBvipYear: true }, 1)?.year).toBe(false);
  });

  it('三档全 false / 缺字段 → null（不是会员）', () => {
    expect(normalizeVipPayload({}, 1)).toBeNull();
    expect(normalizeVipPayload(undefined, 1)).toBeNull();
    expect(
      normalizeVipPayload({ isVip: false, isSvip: false, isBvip: false, vipLevel: 4 }, 1),
    ).toBeNull();
  });

  it('数字时间戳缺失时用可读串兜底（按北京时间解析）', () => {
    const info = normalizeVipPayload({ isVip: true, sVipExpireTime: '2026-11-18 15:52:04' }, 1);
    expect(info?.expireAt).toBe(Date.UTC(2026, 10, 18, 7, 52, 4) / 1000);
    // 完全缺失则不写该字段，而不是写 0（0 会被渲染层当成有效时间）。
    expect(normalizeVipPayload({ isVip: true }, 1)).not.toHaveProperty('expireAt');
  });

  it('parseExpireTime 兼容斜杠、已带时区与非法输入', () => {
    expect(parseExpireTime('2026/11/18 15:52:04')).toBe(Date.UTC(2026, 10, 18, 7, 52, 4) / 1000);
    expect(parseExpireTime('2026-11-18T15:52:04+08:00')).toBe(
      Date.UTC(2026, 10, 18, 7, 52, 4) / 1000,
    );
    expect(parseExpireTime('')).toBeUndefined();
    expect(parseExpireTime('not-a-date')).toBeUndefined();
  });
});

describe('会员接口请求', () => {
  it('带 g_tk（由 p_skey 算）与 p_skey cookie 请求 club.vip', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(response(SVIP_BVIP))));
    vi.stubGlobal('fetch', fetch);

    const info = await fetchVipInfo(credential, 2000);
    expect(info).toMatchObject({ tier: 'bvip', fetchedAt: 2000 });

    const [url, options] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://club.vip.qq.com/qqvip/api/medal/home/queryUserInfo',
    );
    expect(parsed.searchParams.getAll('g_tk')).toEqual([String(computeBkn(credential.pskey))]);
    expect(new Headers(options.headers).get('cookie')).toContain('p_skey=synthetic-pskey');
  });

  it('业务码非 0 时票据类错误抛 WebAuthError，便于换票重试', async () => {
    for (const code of [-3000, -10000]) {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify(response(undefined, code))));
      await expect(fetchVipInfo(credential)).rejects.toBeInstanceOf(WebAuthError);
      vi.unstubAllGlobals();
    }
  });

  it('其它业务错误与缺 data 的响应都抛错，缺 data 按票据失效处理', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(response(undefined, 1))));
    await expect(fetchVipInfo(credential)).rejects.toBeInstanceOf(WebAuthError);

    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 0 })));
    await expect(fetchVipInfo(credential)).rejects.toBeInstanceOf(WebAuthError);
  });

  it('不是会员时返回 null，不抛错', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify(response({ isVip: false, isSvip: false }))),
    );
    await expect(fetchVipInfo(credential)).resolves.toBeNull();
  });
});

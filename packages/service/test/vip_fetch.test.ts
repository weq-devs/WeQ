/**
 * `fetchAccountVipInfo` 的换票策略离线单测：
 *   - 离线只用 seed 票据，不碰 native；
 *   - seed 失效且 QQ 在线时，删掉 seed 后走活 hook 重试一次；
 *   - seed 失效且 QQ 离线时没有第二张票可换，直接失败。
 *
 * `ptFetchCredentials` 全用假实现，fetch 全 mock，不联网、不碰原生模块。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAccountVipInfo } from '../src/account/vip';
import { WebAuthError } from '../src/account/web/credential';

const DATA = { isVip: true, isSvip: true, isBvip: false, vipLevel: 5 };

function okResponse() {
  return new Response(JSON.stringify({ code: 0, data: DATA }));
}

function authFailure() {
  return new Response(JSON.stringify({ code: -3000, message: 'expired' }));
}

/** seed 命中时不该被调用；被调用即说明换票路径不符合预期。 */
function unexplodedNative() {
  return vi.fn(async () => {
    throw new Error('offline: no live hook expected');
  });
}

function liveNative(pskey = 'live-pskey') {
  return vi.fn(async () => ({ success: true, msg: '', skey: 'live-skey', pskey, cookie: '' }));
}

afterEach(() => vi.unstubAllGlobals());

describe('会员信息换票策略', () => {
  it('离线时只用落盘 seed 票据，不调用 native', async () => {
    vi.stubGlobal('fetch', async () => okResponse());
    const nt = unexplodedNative();
    const info = await fetchAccountVipInfo({
      nt: { ptFetchCredentials: nt },
      uin: '10001',
      pid: 0,
      seedPskey: { 'vip.qq.com': 'seed-pskey' },
      now: 10,
    });
    expect(info).toMatchObject({ tier: 'svip', level: 5, fetchedAt: 10 });
    expect(nt).not.toHaveBeenCalled();
  });

  it('离线且 seed 失效：没有第二张票可换，直接失败', async () => {
    vi.stubGlobal('fetch', async () => authFailure());
    const nt = unexplodedNative();
    await expect(
      fetchAccountVipInfo({
        nt: { ptFetchCredentials: nt },
        uin: '10001',
        pid: 0,
        seedPskey: { 'vip.qq.com': 'stale' },
      }),
    ).rejects.toBeInstanceOf(WebAuthError);
    expect(nt).not.toHaveBeenCalled();
  });

  it('离线且完全没有票据时不发请求', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      fetchAccountVipInfo({ nt: { ptFetchCredentials: liveNative() }, uin: '10001', pid: 0 }),
    ).rejects.toThrow('QQ 未在线');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('seed 失效但 QQ 在线：删掉 seed，走活 hook 换票后重试成功', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => (calls++ === 0 ? authFailure() : okResponse()));
    const nt = liveNative();
    const invalidated: string[] = [];
    const info = await fetchAccountVipInfo({
      nt: { ptFetchCredentials: nt },
      uin: '10001',
      pid: 4242,
      seedPskey: { 'vip.qq.com': 'stale' },
      onSeedInvalidated: (domain) => invalidated.push(domain),
      now: 20,
    });

    expect(info).toMatchObject({ tier: 'svip', fetchedAt: 20 });
    expect(invalidated).toEqual(['vip.qq.com']);
    expect(nt).toHaveBeenCalledWith(4242, '10001', 'vip.qq.com');
    expect(calls).toBe(2);
  });

  it('没有 seed 且 QQ 在线：直接走活 hook', async () => {
    vi.stubGlobal('fetch', async () => okResponse());
    const nt = liveNative();
    await fetchAccountVipInfo({ nt: { ptFetchCredentials: nt }, uin: '10001', pid: 4242 });
    expect(nt).toHaveBeenCalledTimes(1);
  });
});

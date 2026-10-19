/**
 * web cgi 凭证层的纯函数单测。
 *
 * `computeBkn` 的唯一实现现在在 TS 侧（`credential.ts`）；原先 native 里的
 * `computeBkn` 已随 `protocol/service` 一并移除。这里钉死 djb2 → 31-bit 的
 * 公式和几个金标准值。
 */

import { describe, expect, it } from 'vitest';
import {
  computeBkn,
  cookieHeader,
  fetchWebTokens,
  WebCredentialProvider,
  type WebCredential,
  type WebNative,
} from '../src/account/web/credential';

/** 「native 拿不到凭据」的桩，用来验证最后那层登录票据兜底。 */
function deadNative(): WebNative {
  return {
    ptFetchCredentials: () =>
      Promise.resolve({
        success: false,
        msg: '桩',
        skey: '',
        pskey: '',
        cookie: '',
        errorKind: 'auth',
      }),
  };
}

describe('computeBkn', () => {
  it.each([
    // 金标准：公式 hash += (hash<<5) + c，最后 & 0x7fffffff
    ['5381 起始的空串', '', 5381 & 0x7fffffff],
    ['常见 skey 形状', '@abcDEF123', 890803408],
  ])('%s', (_label, key, want) => {
    expect(computeBkn(key)).toBe(want);
  });

  it('手算一致性：djb2 变体逐步复算', () => {
    const key = 'test';
    let hash = 5381;
    for (const c of key) hash += (hash << 5) + c.charCodeAt(0);
    expect(computeBkn(key)).toBe(hash & 0x7fffffff);
  });

  it('结果总是非负 31-bit', () => {
    for (const key of ['a', '很长的一串中文skey', '\u00ff\u0100']) {
      const v = computeBkn(key);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0x7fffffff);
    }
  });
});

describe('cookieHeader', () => {
  it('有完整 jar 时优先透传', () => {
    const cred: WebCredential = {
      uin: '12345',
      skey: 's',
      pskey: 'p',
      cookie: 'uin=o12345; RK=xyz; ptcz=abc',
    };
    expect(cookieHeader(cred)).toBe('uin=o12345; RK=xyz; ptcz=abc');
  });

  it('无 jar → 四字段拼装，uin 带 o 前缀', () => {
    const cred: WebCredential = { uin: '12345', skey: 'SK', pskey: 'PSK' };
    expect(cookieHeader(cred)).toBe('uin=o12345; skey=SK; p_uin=o12345; p_skey=PSK');
  });

  it('空 token 被丢弃', () => {
    const cred: WebCredential = { uin: '12345', skey: 'SK', pskey: '' };
    expect(cookieHeader(cred)).toBe('uin=o12345; skey=SK; p_uin=o12345');
  });
});

/**
 * 登录时收下的 seed 票据失效后必须能被删掉 —— 否则下次开账号又会 seed 同一个死
 * 票据，每个域每次请求都先白失败一轮。
 */
describe('WebCredentialProvider 的 seed 失效处理', () => {
  const nt = deadNative();
  const provider = (onSeedInvalidated?: (domain: string) => void): WebCredentialProvider =>
    new WebCredentialProvider(nt, '12345', () => 0, onSeedInvalidated);

  it('invalidate 掉 seed 进来的域时通知持有方', () => {
    const dropped: string[] = [];
    const creds = provider((d) => dropped.push(d));
    creds.seedPskey({ 'vip.qq.com': 'V', 'qzone.qq.com': 'Q' });

    creds.invalidate('vip.qq.com');

    expect(dropped).toEqual(['vip.qq.com']);
  });

  it('没 seed 过的域不打扰持有方；同一个域只通知一次', () => {
    const dropped: string[] = [];
    const creds = provider((d) => dropped.push(d));

    creds.invalidate('vip.qq.com'); // 本来就不是 seed 来的
    creds.seedPskey({ 'qzone.qq.com': 'Q' });
    creds.invalidate('qzone.qq.com');
    creds.invalidate('qzone.qq.com'); // seed 标记已随第一次清掉

    expect(dropped).toEqual(['qzone.qq.com']);
  });

  it('持有方删盘抛错不外泄', () => {
    const creds = provider(() => {
      throw new Error('写配置失败');
    });
    creds.seedPskey({ 'vip.qq.com': 'V' });

    expect(() => creds.invalidate('vip.qq.com')).not.toThrow();
  });

  it('没传回调时照样能 invalidate', () => {
    const creds = provider();
    creds.seedPskey({ 'vip.qq.com': 'V' });

    expect(() => creds.invalidate('vip.qq.com')).not.toThrow();
  });

  it('只有 seed p_skey 且 native 不可用时仍能返回凭据', async () => {
    const creds = provider();
    creds.seedPskey({ 'vip.qq.com': 'V' });

    await expect(creds.forDomain('vip.qq.com')).resolves.toMatchObject({
      uin: '12345',
      skey: '',
      pskey: 'V',
      cookie: 'uin=o12345; p_uin=o12345; p_skey=V',
    });
  });
});

describe('fetchWebTokens 的登录票据兜底', () => {
  it('native 拿不到时退回 seed 的 p_skey', async () => {
    const tokens = await fetchWebTokens(deadNative(), '12345', 0, 'qzone.qq.com', {
      needSkey: true,
      seedPskey: 'SEEDED',
    });

    expect(tokens).toEqual({ skey: '', pskey: 'SEEDED' });
  });

  it('没有 seed 时维持空串，不抛错', async () => {
    const tokens = await fetchWebTokens(deadNative(), '12345', 0, 'qzone.qq.com', {
      needSkey: true,
    });

    expect(tokens).toEqual({ skey: '', pskey: '' });
  });

  it('native 失败时任意域都退回 seed 的 p_skey', async () => {
    const tokens = await fetchWebTokens(deadNative(), '12345', 0, 'tenpay.com', {
      seedPskey: 'SEEDED',
    });

    expect(tokens).toEqual({ skey: '', pskey: 'SEEDED' });
  });
});

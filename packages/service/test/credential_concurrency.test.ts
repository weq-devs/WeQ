import { describe, expect, it, vi } from 'vitest';
import { fetchWebTokens, WebCredentialProvider } from '../src/account/web/credential';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const credentials = (pskey = 'synthetic-p') => ({
  success: true,
  msg: '',
  skey: 'synthetic-s',
  pskey,
  cookie: '',
  errorKind: '',
});

describe('在线凭据并发与失效隔离', () => {
  it('只有 p_skey 的有效回退结果照常可用，不误判为安全拒绝', async () => {
    const nt = {
      ptFetchCredentials: vi.fn(async () => ({ ...credentials(), skey: '', cookie: '' })),
    };
    const provider = new WebCredentialProvider(nt, '10001', () => 42);
    expect(await provider.forDomain('vip.qq.com')).toMatchObject({
      skey: '',
      pskey: 'synthetic-p',
      cookie: 'uin=o10001; p_uin=o10001; p_skey=synthetic-p',
    });
  });
  it('跨 provider 与窗口入口只合并相同 native、账号、进程和域的在途请求', async () => {
    const pending = deferred<ReturnType<typeof credentials>>();
    const nt = { ptFetchCredentials: vi.fn(() => pending.promise) };
    const first = new WebCredentialProvider(nt, '10001', () => 42);
    const second = new WebCredentialProvider(nt, '10001', () => 42);
    const requests = [
      first.forDomain('vip.qq.com'),
      second.forDomain('vip.qq.com'),
      fetchWebTokens(nt, '10001', 42, 'vip.qq.com'),
    ];
    expect(nt.ptFetchCredentials).toHaveBeenCalledTimes(1);
    pending.resolve(credentials());
    await Promise.all(requests);
    await second.forDomain('vip.qq.com');
    expect(nt.ptFetchCredentials).toHaveBeenCalledTimes(1);
    await fetchWebTokens(nt, '10001', 42, 'vip.qq.com');
    expect(nt.ptFetchCredentials).toHaveBeenCalledTimes(2);
  });

  it('不同账号、进程、域与 native 不共享凭据，失败后允许重试', async () => {
    const nt = { ptFetchCredentials: vi.fn(async () => credentials()) };
    const other = { ptFetchCredentials: vi.fn(async () => credentials('other-p')) };
    await Promise.all([
      fetchWebTokens(nt, '10001', 42, 'vip.qq.com'),
      fetchWebTokens(nt, '10002', 42, 'vip.qq.com'),
      fetchWebTokens(nt, '10001', 43, 'vip.qq.com'),
      fetchWebTokens(nt, '10001', 42, 'qun.qq.com'),
      fetchWebTokens(other, '10001', 42, 'vip.qq.com'),
    ]);
    expect(nt.ptFetchCredentials).toHaveBeenCalledTimes(4);
    expect(other.ptFetchCredentials).toHaveBeenCalledOnce();
    nt.ptFetchCredentials.mockRejectedValueOnce(new Error('合成网络错误'));
    const provider = new WebCredentialProvider(nt, '10001', () => 42);
    await expect(provider.forDomain('vip.qq.com')).rejects.toThrow('合成网络错误');
    await expect(provider.forDomain('vip.qq.com')).resolves.toMatchObject({ pskey: 'synthetic-p' });
  });

  it('切换 PID 后不能使用先前进程的已缓存票据', async () => {
    let pid = 42;
    const nt = {
      ptFetchCredentials: vi.fn(async (current: number) => credentials(`p-${current}`)),
    };
    const provider = new WebCredentialProvider(nt, '10001', () => pid);
    expect((await provider.forDomain('vip.qq.com')).pskey).toBe('p-42');
    pid = 43;
    expect((await provider.forDomain('vip.qq.com')).pskey).toBe('p-43');
    expect(nt.ptFetchCredentials).toHaveBeenCalledTimes(2);
  });

  it('invalidate 后不重新接收仍在返回的旧凭据，并可重新取票', async () => {
    const pending = deferred<ReturnType<typeof credentials>>();
    const nt = { ptFetchCredentials: vi.fn(() => pending.promise) };
    const provider = new WebCredentialProvider(nt, '10001', () => 42);
    const first = provider.forDomain('vip.qq.com');
    const rejected = expect(first).rejects.toThrow('失效');
    provider.invalidate('vip.qq.com');
    pending.resolve(credentials('old-p'));
    await rejected;
    nt.ptFetchCredentials.mockResolvedValueOnce(credentials('new-p'));
    expect((await provider.forDomain('vip.qq.com')).pskey).toBe('new-p');
  });

  it('读取期间 seed 更新不能被迟到的 native 票据覆盖', async () => {
    const pending = deferred<ReturnType<typeof credentials>>();
    const nt = { ptFetchCredentials: vi.fn(() => pending.promise) };
    const provider = new WebCredentialProvider(nt, '10001', () => 42);
    const request = provider.forDomain('vip.qq.com');
    const rejected = expect(request).rejects.toThrow('失效');
    provider.seedPskey({ 'vip.qq.com': 'new-seed' });
    pending.resolve(credentials('old-p'));
    await rejected;
    expect((await provider.forDomain('vip.qq.com')).pskey).toBe('new-seed');
  });

  it('失效后可立即取新票，旧请求结束不会撤销新的共享在途读取', async () => {
    const old = deferred<ReturnType<typeof credentials>>();
    const fresh = deferred<ReturnType<typeof credentials>>();
    const nt = {
      ptFetchCredentials: vi.fn().mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise),
    };
    const provider = new WebCredentialProvider(nt, '10001', () => 42);
    const first = provider.forDomain('vip.qq.com');
    const rejected = expect(first).rejects.toThrow('失效');
    provider.invalidate('vip.qq.com');
    const next = provider.forDomain('vip.qq.com');
    expect(nt.ptFetchCredentials).toHaveBeenCalledTimes(2);
    old.resolve(credentials('old-p'));
    await rejected;
    const joined = new WebCredentialProvider(nt, '10001', () => 42).forDomain('vip.qq.com');
    expect(nt.ptFetchCredentials).toHaveBeenCalledTimes(2);
    fresh.resolve(credentials('new-p'));
    expect((await next).pskey).toBe('new-p');
    expect((await joined).pskey).toBe('new-p');
  });
});

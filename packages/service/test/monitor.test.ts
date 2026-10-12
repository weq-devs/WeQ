import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import type { AccountConfigService } from '../src/account/user_config';
import type { AttachHook } from '../src/bootstrap/attach';
import { AccountMonitorService } from '../src/account/monitor';

const tickets = vi.hoisted(() => ({ rkeys: vi.fn(), clientKey: vi.fn(), dress: vi.fn() }));
vi.mock('../src/account/online_ticket', () => ({
  fetchDownloadRkeys: tickets.rkeys,
  fetchClientKey: tickets.clientKey,
}));
vi.mock('../src/account/home_dress', () => ({ fetchHomeDress: tickets.dress }));
vi.mock('../src/account/user_config', () => ({
  rkeyExpiryMs: (key: { expiresAt: number }) => key.expiresAt,
  clientKeyExpiryMs: (key: { expiresAt: number }) => key.expiresAt,
}));

const material = { a2: 'aa', d2: 'bb', d2Key: 'cc'.repeat(16) };

function fixture(stored = false) {
  let pid: number | null = 42;
  let enabled = true;
  let registered = false;
  const record = {
    uid: 'u_fixture',
    guid: 'ab'.repeat(16),
    qqOnline: true,
    qqPid: 42,
    session: stored ? { ...material, pid: 42 } : null,
    rkeys: [] as Array<{ type: number; expiresAt: number }>,
    clientKey: null as null | { expiresAt: number },
  };
  const nt = {
    resetPacketSequence: vi.fn(() => 1),
    readDeviceGuid: vi.fn(() => record.guid),
    resolveAppidFromMajor: vi.fn(() => ({ appid: '123' })),
    setSsoSession: vi.fn(async () => {
      registered = true;
    }),
    hasSsoSession: vi.fn(async () => registered),
    clearSsoSession: vi.fn(async () => {
      registered = false;
      return true;
    }),
  };
  const config = {
    getRecord: () => record,
    setGuid: (guid: string) => {
      record.guid = guid;
    },
    setOnline: (online: boolean, currentPid: number) => {
      record.qqOnline = online;
      record.qqPid = currentPid;
    },
    setSessionMaterial: (value: typeof record.session) => {
      record.session = value;
    },
    setRkeys: vi.fn((value: typeof record.rkeys) => {
      record.rkeys = value;
    }),
    setClientKey: vi.fn((value: { expiresAt: number }) => {
      record.clientKey = value;
    }),
    setHomeDress: vi.fn(),
  };
  const hook = {
    attach: vi.fn(async () => ({ ...material })),
    ensure: vi.fn(async () => ({ ...material })),
    reset: vi.fn(),
  };
  const platform = {
    native: { ntHelper: nt },
    resolveQqPid: () => pid,
    qqDataRoot: () => '/fixture',
    qqMajorNodePath: () => '/fixture/major.node',
    qqWrapperNodePath: () => '/fixture/wrapper.node',
  };
  const monitor = new AccountMonitorService(
    { context: { uin: '12345' } } as unknown as AccountSession,
    platform as unknown as Platform,
    config as unknown as AccountConfigService,
    () => enabled,
    hook as AttachHook,
  );
  return {
    monitor,
    platform: platform as unknown as Platform,
    hook,
    nt,
    record,
    config,
    setPid: (value: number | null) => {
      pid = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T00:00:00Z'));
  vi.clearAllMocks();
  tickets.rkeys.mockResolvedValue([{ type: 10, expiresAt: Date.now() + 3_600_000 }]);
  tickets.clientKey.mockResolvedValue({ expiresAt: Date.now() + 3_600_000, ttlSeconds: 3600 });
  tickets.dress.mockResolvedValue({});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('account monitor authorization and SSO readiness', () => {
  it('backs off failed scans from 30 seconds to a bounded five minutes', async () => {
    const f = fixture();
    f.hook.ensure.mockRejectedValue(new Error('worker unavailable'));
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.hook.ensure).toHaveBeenCalledTimes(1);
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      const before = f.hook.ensure.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 5000);
      expect(f.hook.ensure).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.hook.ensure).toHaveBeenCalledTimes(before + 1);
    }
    f.monitor.stop();
  });

  it('keeps cancellation quiet until an explicit refresh', async () => {
    const f = fixture();
    f.hook.ensure.mockRejectedValueOnce(new Error('已取消授权，未读取 QQ 进程内存。'));
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.hook.ensure).toHaveBeenCalledTimes(1);
    expect(await f.monitor.harvestRkeysNow()).toBe(true);
    expect(f.hook.ensure).toHaveBeenCalledTimes(2);
    f.monitor.stop();
  });

  it('clears cancellation when the QQ PID changes', async () => {
    const f = fixture();
    f.hook.ensure.mockRejectedValueOnce(new Error('已取消授权，未读取 QQ 进程内存。'));
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    f.setPid(43);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.hook.ensure).toHaveBeenCalledTimes(2);
    expect(f.hook.ensure).toHaveBeenLastCalledWith(43, '12345', expect.any(AbortSignal));
    f.monitor.stop();
  });

  it('lets an explicit refresh retry immediately during the background backoff', async () => {
    const f = fixture();
    f.hook.ensure.mockRejectedValueOnce(new Error('worker unavailable'));
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.monitor.harvestRkeysNow()).toBe(true);
    expect(f.hook.ensure).toHaveBeenCalledTimes(2);
    f.monitor.stop();
  });

  it('reports an in-flight failure to the manual caller and retries after it settles', async () => {
    const f = fixture();
    let rejectScan!: (error: Error) => void;
    f.hook.ensure.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectScan = reject;
        }),
    );
    const first = f.monitor.harvestRkeysNow();
    const joined = f.monitor.harvestRkeysNow();
    rejectScan(new Error('worker unavailable'));
    expect(await first).toBe(false);
    expect(await joined).toBe(false);
    expect(f.hook.ensure).toHaveBeenCalledTimes(1);
    expect(await f.monitor.harvestRkeysNow()).toBe(true);
    expect(f.hook.ensure).toHaveBeenCalledTimes(2);
  });

  it('does not ask for authorization or send tickets when identity is missing', async () => {
    const f = fixture();
    f.record.uid = '';
    expect(await f.monitor.harvestRkeysNow()).toBe(false);
    expect(f.hook.ensure).not.toHaveBeenCalled();
    expect(tickets.rkeys).not.toHaveBeenCalled();
  });

  it('stops background retries when the device guid is missing (non-recoverable)', async () => {
    const f = fixture();
    // 缺 guid（例如全新装机上三条路都读不到）不会靠重试自愈：起一轮后台 poll
    // 之后应当停手，而不是每 5s 刷一次 harvest。
    f.record.guid = '';
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.hook.ensure).not.toHaveBeenCalled();
    // 之后的轮询也不该再尝试（不读内存、不发包）。
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.hook.ensure).not.toHaveBeenCalled();
    expect(tickets.rkeys).not.toHaveBeenCalled();
    // 显式重试（用户手动「立即重新获取」）仍要放行一次。
    expect(await f.monitor.harvestRkeysNow()).toBe(false);
    expect(f.hook.ensure).not.toHaveBeenCalled();
    f.monitor.stop();
  });

  it('propagates stored-material registration failure without rescanning', async () => {
    const f = fixture(true);
    f.nt.setSsoSession.mockRejectedValue(new Error('registration failed'));
    expect(await f.monitor.harvestRkeysNow()).toBe(false);
    expect(f.hook.ensure).not.toHaveBeenCalled();
    expect(tickets.rkeys).not.toHaveBeenCalled();
  });

  it('does not fetch tickets after newly scanned material fails registration', async () => {
    const f = fixture();
    f.nt.setSsoSession.mockRejectedValue(new Error('registration failed'));
    expect(await f.monitor.harvestRkeysNow()).toBe(false);
    expect(f.hook.ensure).toHaveBeenCalledTimes(1);
    expect(tickets.rkeys).not.toHaveBeenCalled();
  });

  it('reuses a confirmed native registration but installs changed material and identity', async () => {
    const f = fixture(true);
    expect(await f.monitor.harvestRkeysNow()).toBe(true);
    expect(await f.monitor.harvestRkeysNow()).toBe(true);
    expect(f.nt.setSsoSession).toHaveBeenCalledTimes(1);
    f.record.session!.d2 = 'dd';
    expect(await f.monitor.harvestRkeysNow()).toBe(true);
    expect(f.nt.setSsoSession).toHaveBeenCalledTimes(2);
    f.record.guid = 'ef'.repeat(16);
    expect(await f.monitor.harvestRkeysNow()).toBe(true);
    expect(f.nt.setSsoSession).toHaveBeenCalledTimes(3);
    await f.nt.clearSsoSession();
    expect(await f.monitor.harvestRkeysNow()).toBe(true);
    expect(f.nt.setSsoSession).toHaveBeenCalledTimes(4);
    expect(f.hook.ensure).not.toHaveBeenCalled();
  });

  it('joins concurrent readiness checks instead of closing and registering twice', async () => {
    const f = fixture(true);
    await Promise.all([f.monitor.harvestRkeysNow(), f.monitor.harvestRkeysNow()]);
    expect(f.nt.setSsoSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the auto-attach gate effective for explicit refreshes', async () => {
    const f = fixture();
    f.setEnabled(false);
    expect(await f.monitor.harvestRkeysNow()).toBe(false);
    expect(f.hook.ensure).not.toHaveBeenCalled();
    expect(tickets.rkeys).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe('account monitor closed-session isolation', () => {
  it('does not save or register a scan which returns after stop', async () => {
    const f = fixture();
    const scan = deferred<typeof material>();
    f.hook.ensure.mockReturnValueOnce(scan.promise);
    const request = f.monitor.harvestRkeysNow();
    f.monitor.stop();
    scan.resolve(material);
    expect(await request).toBe(false);
    expect(f.record.session).toBeNull();
    expect(f.nt.setSsoSession).not.toHaveBeenCalled();
    expect(tickets.rkeys).not.toHaveBeenCalled();
  });

  it('does not save late tickets or schedule another poll after stop/start', async () => {
    const f = fixture(true);
    const keys = deferred<Array<{ type: number; expiresAt: number }>>();
    tickets.rkeys.mockReturnValueOnce(keys.promise);
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    f.monitor.stop();
    f.setEnabled(false);
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    keys.resolve([{ type: 10, expiresAt: Date.now() + 1000 }]);
    await flushPromises();
    expect(f.config.setRkeys).not.toHaveBeenCalled();
    expect(tickets.clientKey).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    f.monitor.stop();
  });

  it('ignores late dress results from an ended session', async () => {
    const f = fixture(true);
    const dress = deferred<object>();
    tickets.dress.mockReturnValueOnce(dress.promise);
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    f.monitor.stop();
    dress.resolve({});
    await flushPromises();
    expect(f.config.setHomeDress).not.toHaveBeenCalled();
  });

  it('clears a registration that finishes after stop before installing the next one', async () => {
    const f = fixture(true);
    const registration = deferred<void>();
    f.nt.setSsoSession.mockReturnValueOnce(registration.promise);
    const first = f.monitor.harvestRkeysNow();
    await flushPromises();
    expect(f.nt.setSsoSession).toHaveBeenCalledTimes(1);
    f.monitor.stop();
    f.monitor.start();
    const next = f.monitor.harvestRkeysNow();
    registration.resolve();
    expect(await first).toBe(false);
    expect(await next).toBe(true);
    expect(f.nt.clearSsoSession.mock.invocationCallOrder[0]).toBeLessThan(
      f.nt.setSsoSession.mock.invocationCallOrder[1]!,
    );
    f.monitor.stop();
  });
  it('orders old cleanup before another monitor registers on the same native PID', async () => {
    const f = fixture(true);
    expect(await f.monitor.harvestRkeysNow()).toBe(true);
    const cleared = deferred<void>();
    f.nt.clearSsoSession.mockImplementationOnce(async () => {
      await cleared.promise;
      return true;
    });
    f.monitor.stop();
    await flushPromises();
    const replacement = new AccountMonitorService(
      { context: { uin: '12345' } } as unknown as AccountSession,
      f.platform,
      f.config as unknown as AccountConfigService,
      () => true,
      f.hook,
    );
    const request = replacement.harvestRkeysNow();
    await flushPromises();
    expect(f.nt.setSsoSession).toHaveBeenCalledTimes(1);
    cleared.resolve();
    expect(await request).toBe(true);
    expect(f.nt.setSsoSession).toHaveBeenCalledTimes(2);
    replacement.stop();
    await flushPromises();
  });

  it('does not let a stale monitor clear a newer monitor registration', async () => {
    const f = fixture(true);
    expect(await f.monitor.harvestRkeysNow()).toBe(true);
    const replacement = new AccountMonitorService(
      { context: { uin: '12345' } } as unknown as AccountSession,
      f.platform,
      f.config as unknown as AccountConfigService,
      () => true,
      f.hook,
    );
    expect(await replacement.harvestRkeysNow()).toBe(true);
    f.nt.clearSsoSession.mockClear();
    f.monitor.stop();
    await flushPromises();
    expect(f.nt.clearSsoSession).not.toHaveBeenCalled();
    replacement.stop();
    await flushPromises();
    expect(f.nt.clearSsoSession).toHaveBeenCalledOnce();
  });
  it('does not publish a read that finishes after automatic reading is disabled', async () => {
    const f = fixture();
    const scan = deferred<typeof material>();
    f.hook.ensure.mockReturnValueOnce(scan.promise);
    const request = f.monitor.harvestRkeysNow();
    f.setEnabled(false);
    scan.resolve(material);
    expect(await request).toBe(false);
    expect(f.record.session).toBeNull();
    expect(f.nt.setSsoSession).not.toHaveBeenCalled();
    expect(tickets.rkeys).not.toHaveBeenCalled();
    f.monitor.stop();
    await flushPromises();
  });
});

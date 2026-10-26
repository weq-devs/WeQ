// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { AuthorizationFullModeMonitor } from '../src/main/authorization/full_mode';
import { clearFullMode, fullModeAllowed } from '../src/main/context/full_mode';
import type { LongTermAuthorizationStatus } from '../src/shared/long_term_authorization';

const monitors: AuthorizationFullModeMonitor[] = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  vi.useRealTimers();
});
function fixture() {
  const settings = { autoAttachQq: false };
  const host = {
    account: {} as object | null,
    accountIsStatic: false,
    bootstrap: { userConfig: { getSettings: () => settings } },
    refreshRkeysNow: vi.fn(async () => false),
  };
  const status: LongTermAuthorizationStatus = {
    platform: 'darwin',
    state: 'ready',
    message: 'synthetic ready',
  };
  const probe = vi.fn(async () => status);
  const monitor = new AuthorizationFullModeMonitor(() => host, probe);
  monitors.push(monitor);
  return { host, settings, status, probe, monitor };
}

it('助手就绪后请求本来源完整功能并准备凭据，不修改自动偏好或冒称准备成功', async () => {
  const f = fixture();
  expect(fullModeAllowed(f.host)).toBe(false);
  expect(await f.monitor.check()).toBe(f.status);
  expect(fullModeAllowed(f.host)).toBe(true);
  expect(f.settings.autoAttachQq).toBe(false);
  expect(f.host.refreshRkeysNow).toHaveBeenCalledOnce();
  expect(await f.monitor.check()).toBe(f.status);
  expect(f.host.refreshRkeysNow).toHaveBeenCalledOnce();
});

it.each(['unavailable', 'not-installed', 'needs-repair'] as const)(
  '助手 %s 时不启用或准备凭据',
  async (state) => {
    const f = fixture();
    f.status.state = state;
    await f.monitor.check();
    expect(fullModeAllowed(f.host)).toBe(false);
    expect(f.host.refreshRkeysNow).not.toHaveBeenCalled();
  },
);

it.each(['switch', 'close', 'retire', 'static', 'stop'] as const)(
  '检查期间 %s 后忽略迟到就绪结果',
  async (change) => {
    const f = fixture();
    const task = f.monitor.check();
    if (change === 'switch') f.host.account = {};
    if (change === 'close') f.host.account = null;
    if (change === 'retire') clearFullMode(f.host);
    if (change === 'static') f.host.accountIsStatic = true;
    if (change === 'stop') f.monitor.stop();
    await task;
    expect(fullModeAllowed(f.host)).toBe(false);
    expect(f.host.refreshRkeysNow).not.toHaveBeenCalled();
  },
);

it('检查开始时没有账号，期间打开账号也不继承该结果', async () => {
  const f = fixture();
  f.host.account = null;
  const task = f.monitor.check();
  f.host.account = {};
  await task;
  expect(fullModeAllowed(f.host)).toBe(false);
});

it('安装/修复返回就绪也走同一来源校验', async () => {
  const f = fixture();
  const install = vi.fn(async () => f.status);
  await f.monitor.check(install);
  expect(install).toHaveBeenCalledOnce();
  expect(f.probe).not.toHaveBeenCalled();
  expect(fullModeAllowed(f.host)).toBe(true);
});

it('启动后无需打开设置，助手恢复连接时自动重试；停用后不再探测', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.probe.mockRejectedValueOnce(new Error('synthetic disconnected'));
  f.monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(fullModeAllowed(f.host)).toBe(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(fullModeAllowed(f.host)).toBe(true);
  expect(f.host.refreshRkeysNow).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.probe).toHaveBeenCalledTimes(2);
  f.monitor.stop();
  await vi.advanceTimersByTimeAsync(10000);
  expect(vi.getTimerCount()).toBe(0);
});

it('静态来源不后台探测，换成在线来源后重新检查', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.host.accountIsStatic = true;
  f.monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.probe).not.toHaveBeenCalled();
  f.host.account = {};
  f.host.accountIsStatic = false;
  await vi.advanceTimersByTimeAsync(5000);
  expect(fullModeAllowed(f.host)).toBe(true);
});

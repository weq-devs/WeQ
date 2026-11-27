// @vitest-environment node
import { withQqDatabaseWrite } from '@weq/db';
import type { QqCapabilityMode } from '@weq/service/qq-capability-mode';
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
import { bootstrapRouter } from '../src/main/ipc/routers/bootstrap';
import { fullModeAllowed, retireFullModeSource } from '../src/main/context/full_mode';
const f = vi.hoisted(() => {
  const settings = { autoAttachQq: false, qqCapabilityMode: 'local' as QqCapabilityMode };
  const proxy = { enabled: false, tunnels: 0 };
  const setProxy = vi.fn(async (_root: string, enabled: boolean) => {
    proxy.enabled = enabled;
  });
  const services = {
    accountConfig: { getRecord: () => ({ uin: '10001', configId: 'synthetic-live' }) },
  };
  const host = {
    account: { context: { uin: '10001' } },
    platform: {
      tencentFilesRoots: () => ['/fixture/qq-data'],
      qqDataRoot: () => null,
      accountDir: () => null,
      native: { ntHelper: { configureQqReadOnlyRoots: vi.fn(() => true) } },
    },
    bootstrap: {
      qqSyncRoot: '/fixture/qq-sync',
      userConfig: {
        cacheBaseDir: () => '/fixture/weq-cache',
        listAccountConfigs: () => [],
        getSettings: () => settings,
        getSetting: (key: keyof typeof settings) => settings[key],
        setSettings: (patch: Partial<typeof settings>) => {
          Object.assign(settings, patch);
          if (patch.qqCapabilityMode)
            settings.autoAttachQq = ['online', 'complete'].includes(patch.qqCapabilityMode);
          return settings;
        },
      },
    },
    refreshRkeysNow: vi.fn(),
    services,
  };
  return { host, settings, services, proxy, setProxy };
});
vi.mock('../src/main/context/app_context', () => ({
  accountEventBus: new EventEmitter(),
  getAppContext: () => f.host,
  requireBootstrap: () => f.host.bootstrap,
}));
vi.mock('../src/main/qq_sync/runtime', () => ({
  isQqSyncProxyEnabled: () => f.proxy.enabled,
  qqSyncStatus: async () => ({ ...f.proxy }),
  setQqSyncProxyEnabled: f.setProxy,
  ensureQqSyncProxy: vi.fn(),
  setQqSyncPort: vi.fn(),
}));
beforeEach(() => {
  retireFullModeSource(f.host);
  f.host.account = { context: { uin: '10001' } };
  f.host.services = f.services;
  f.settings.autoAttachQq = false;
  f.settings.qqCapabilityMode = 'local';
  f.proxy.enabled = false;
  f.proxy.tunnels = 0;
  f.setProxy.mockClear();
  f.host.platform.native.ntHelper.configureQqReadOnlyRoots.mockClear();
  f.host.refreshRkeysNow.mockReset().mockResolvedValue(true);
});
const input = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-live' };
it('受限详情的启用入口保存同一个设置，实际凭据由监视器准备', async () => {
  expect(fullModeAllowed(f.host)).toBe(false);
  expect(await accountRouter.createCaller({}).requestFullMode(input)).toEqual({ requested: true });
  expect(fullModeAllowed(f.host)).toBe(true);
  expect(f.settings.autoAttachQq).toBe(true);
  expect(f.host.refreshRkeysNow).not.toHaveBeenCalled();
});
it('从受限详情启用后可在设置中关闭，再次开启可恢复', async () => {
  const caller = bootstrapRouter.createCaller({});
  expect(await caller.getFullModeState()).toEqual({ allowed: false });
  await accountRouter.createCaller({}).requestFullMode(input);
  expect(await caller.getFullModeState()).toEqual({ allowed: true });
  await caller.setQqCapabilityMode({ mode: 'local' });
  expect(await caller.getFullModeState()).toEqual({ allowed: false });
  expect(f.settings.autoAttachQq).toBe(false);
  await caller.setQqCapabilityMode({ mode: 'online' });
  expect(await caller.getFullModeState()).toEqual({ allowed: true });
});
it.each([
  { ...input, expectedAccountUin: '10002' },
  { ...input, expectedAccountConfigId: 'synthetic-backup' },
])('旧账号或同号旧来源不能授权当前来源', async (stale) => {
  await expect(accountRouter.createCaller({}).requestFullMode(stale)).rejects.toThrow('已切换');
  expect(fullModeAllowed(f.host)).toBe(false);
});
it('拒绝来源缺失或未经授权的请求', async () => {
  await expect(accountRouter.createCaller({}).requestFullMode(JSON.parse('{}'))).rejects.toThrow();
  await expect(
    accountRouter
      .createCaller({
        authorize: () => {
          throw new Error('合成拒绝');
        },
      })
      .requestFullMode(input),
  ).rejects.toThrow('合成拒绝');
  expect(fullModeAllowed(f.host)).toBe(false);
});
it('刷新凭据前验证完整来源，等待后不把旧成功交给新实例', async () => {
  await expect(
    accountRouter
      .createCaller({})
      .refreshRkeys({ ...input, expectedAccountConfigId: 'synthetic-old' }),
  ).rejects.toThrow('已切换');
  expect(f.host.refreshRkeysNow).not.toHaveBeenCalled();
  f.host.refreshRkeysNow.mockImplementationOnce(async () => {
    f.host.services = {
      accountConfig: { getRecord: () => ({ uin: '10001', configId: 'synthetic-live' }) },
    };
    return true;
  });
  await expect(accountRouter.createCaller({}).refreshRkeys(input)).rejects.toThrow('已切换');
});

it('完整模式自动启动代理，已有连接按原流程确认后停用', async () => {
  const caller = bootstrapRouter.createCaller({});
  await expect(caller.setQqCapabilityMode({ mode: 'complete' })).resolves.toMatchObject({
    status: 'saved',
    mode: 'complete',
  });
  expect(f.proxy.enabled).toBe(true);
  f.proxy.tunnels = 1;
  await expect(caller.setQqCapabilityMode({ mode: 'online' })).resolves.toEqual({
    status: 'confirm-disconnect',
  });
  expect(f.settings.qqCapabilityMode).toBe('complete');
  expect(f.proxy.enabled).toBe(true);
  await caller.setQqCapabilityMode({ mode: 'online', disconnectProxy: true });
  expect(f.proxy.enabled).toBe(false);
  expect(f.settings.qqCapabilityMode).toBe('online');
  expect(fullModeAllowed(f.host)).toBe(true);
});

it('已开始的数据库修改完成后才允许切入只读', async () => {
  const caller = bootstrapRouter.createCaller({});
  let finish!: () => void;
  const running = withQqDatabaseWrite(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    await expect(caller.setQqCapabilityMode({ mode: 'read-only' })).rejects.toThrow(
      '请等待当前操作完成',
    );
    expect(f.settings.qqCapabilityMode).toBe('local');
    expect(f.host.platform.native.ntHelper.configureQqReadOnlyRoots).not.toHaveBeenCalled();
  } finally {
    finish();
    await running;
  }
  await caller.setQqCapabilityMode({ mode: 'read-only' });
  expect(f.settings.qqCapabilityMode).toBe('read-only');
  expect(f.host.platform.native.ntHelper.configureQqReadOnlyRoots).toHaveBeenCalledWith([
    '/fixture/qq-data',
  ]);
});

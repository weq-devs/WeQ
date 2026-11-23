// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
import { bootstrapRouter } from '../src/main/ipc/routers/bootstrap';
import { fullModeAllowed, retireFullModeSource } from '../src/main/context/full_mode';
const f = vi.hoisted(() => {
  const settings = { autoAttachQq: false };
  const services = {
    accountConfig: { getRecord: () => ({ uin: '10001', configId: 'synthetic-live' }) },
  };
  const host = {
    account: { context: { uin: '10001' } },
    bootstrap: {
      userConfig: {
        getSettings: () => settings,
        setSettings: (patch: Partial<typeof settings>) => Object.assign(settings, patch),
      },
    },
    refreshRkeysNow: vi.fn(),
    services,
  };
  return { host, settings, services };
});
vi.mock('../src/main/context/app_context', () => ({
  accountEventBus: new EventEmitter(),
  getAppContext: () => f.host,
  requireBootstrap: () => f.host.bootstrap,
}));
beforeEach(() => {
  retireFullModeSource(f.host);
  f.host.account = { context: { uin: '10001' } };
  f.host.services = f.services;
  f.settings.autoAttachQq = false;
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
  await caller.setAutoAttachQq({ enabled: false });
  expect(await caller.getFullModeState()).toEqual({ allowed: false });
  expect(f.settings.autoAttachQq).toBe(false);
  await caller.setAutoAttachQq({ enabled: true });
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

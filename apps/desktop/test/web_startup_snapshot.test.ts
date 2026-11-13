// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { initTRPC } from '@trpc/server';

const api = vi.hoisted(() => ({
  backup: vi.fn(),
  native: vi.fn(),
  current: vi.fn(),
  settings: vi.fn(),
  config: vi.fn(),
  install: vi.fn(),
  configs: vi.fn(),
  auto: vi.fn(),
}));
vi.mock('../src/main/ipc/trpc', () => {
  const t = initTRPC.create();
  return { procedure: t.procedure, router: t.router };
});
vi.mock('../src/main/ipc/routers/bootstrap', () => ({
  bootstrapRouter: {
    createCaller: () => ({
      backupStartup: api.backup,
      nativeStatus: api.native,
      currentAccount: api.current,
      getSettings: api.settings,
      describeInstall: api.install,
      listAccountConfigs: api.configs,
      getAutoEnter: api.auto,
    }),
  },
}));
vi.mock('../src/main/ipc/routers/account', () => ({
  accountRouter: { createCaller: () => ({ getAccountConfig: api.config }) },
}));
import { startupRouter } from '../src/main/ipc/routers/startup';
import { runtimeMaintenance } from '../src/main/runtime_maintenance';

const healthy = { ok: true, result: null, client: null };
beforeEach(() => {
  vi.resetAllMocks();
  api.backup.mockResolvedValue(healthy);
  api.native.mockResolvedValue(null);
  api.current.mockResolvedValue({ uin: '10001' });
  api.settings.mockResolvedValue({ renderTextMarkdown: true });
  api.config.mockResolvedValue({ configId: 'synthetic', uin: '10001' });
  api.install.mockResolvedValue({ hasQqExe: true });
  api.configs.mockResolvedValue([]);
  api.auto.mockResolvedValue(null);
});

it('一次快照返回现有账号配置，不触发账号打开或无关的安装探测', async () => {
  const result = await startupRouter.createCaller({}).snapshot();
  expect(result.snapshot?.current).toEqual({ uin: '10001' });
  expect(result.snapshot?.config).toEqual({ configId: 'synthetic', uin: '10001' });
  expect(api.config).toHaveBeenCalledOnce();
  expect(api.install).not.toHaveBeenCalled();
});

it.each([
  { ok: false, result: null },
  { ok: true, result: { clientPending: true } },
])('恢复未完成时只返回恢复回执：%j', async (backup) => {
  api.backup.mockResolvedValue(backup);
  expect((await startupRouter.createCaller({}).snapshot()).snapshot).toBeNull();
  expect(api.native).not.toHaveBeenCalled();
  expect(api.current).not.toHaveBeenCalled();
  expect(api.config).not.toHaveBeenCalled();
});

it('维护期间保留恢复读取，不访问业务状态', async () => {
  await runtimeMaintenance.run(async () => {
    expect((await startupRouter.createCaller({}).snapshot()).snapshot).toBeNull();
    expect(api.native).not.toHaveBeenCalled();
  });
});

it('无后台账号时补齐主页所需状态，单项失败仍保留成功结果', async () => {
  api.current.mockResolvedValue(null);
  api.configs.mockRejectedValue(Error('synthetic unavailable'));
  const result = await startupRouter.createCaller({}).snapshot();
  expect(result.snapshot?.home).toEqual([{ hasQqExe: true }, undefined, null]);
  expect(api.config).not.toHaveBeenCalled();
  expect(api.auto).toHaveBeenCalledWith({ startup: false });
});

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { qqRuntimeRouter } from '../src/main/ipc/routers/qq_runtime';

const mock = vi.hoisted(() => ({
  instance: 'instance-a' as string | null,
  mode: 'managed',
  allowed: true,
  account: null as { context: { uin: string } } | null,
  managed: { instanceId: 'instance-a', dbKey: 'private-db-key' },
  start: vi.fn(async (_uin?: string) => ({})),
  stop: vi.fn(async () => ({})),
  refresh: vi.fn(async () => {}),
  refreshExternal: vi.fn(async () => {}),
  clear: vi.fn(),
  open: vi.fn(async () => {}),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: mock.account,
    managedQQ: mock.managed,
    clearAccount: mock.clear,
    qqRuntime: {
      snapshot: () => ({ instanceId: mock.instance, mode: mock.mode, phase: 'awaiting-login' }),
      startManaged: mock.start,
      stop: mock.stop,
      refreshQr: mock.refresh,
      refreshExternal: mock.refreshExternal,
    },
  }),
  requireAttachEnabled: () => {
    if (!mock.allowed) throw new Error('完全离线模式');
  },
  requireBootstrap: () => ({ userConfig: { getSettings: () => ({ autoAttachQq: mock.allowed }) } }),
  requirePlatform: () => ({ qqExePath: () => '/Applications/QQ.app/Contents/MacOS/QQ' }),
}));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  getHost: () => ({ revealPath: mock.open, canReveal: true }),
}));
beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' });
  vi.clearAllMocks();
  mock.instance = 'instance-a';
  mock.mode = 'managed';
  mock.allowed = true;
  mock.account = null;
  mock.managed = { instanceId: 'instance-a', dbKey: 'private-db-key' };
});
afterEach(() => vi.unstubAllGlobals());
describe('QQ 运行时 IPC 绑定', () => {
  it('旧实例请求不能停止或刷新当前实例', async () => {
    const caller = qqRuntimeRouter.createCaller({});
    await expect(caller.stop({ expectedInstanceId: 'old-instance' })).rejects.toThrow(/已切换/);
    await expect(caller.refreshQr({ expectedInstanceId: 'old-instance' })).rejects.toThrow(
      /已切换/,
    );
    expect(mock.stop).not.toHaveBeenCalled();
    expect(mock.refresh).not.toHaveBeenCalled();
  });
  it('完全离线或已有活动账号时不启动托管 QQ', async () => {
    const caller = qqRuntimeRouter.createCaller({});
    mock.allowed = false;
    await expect(caller.start({ expectedInstanceId: 'instance-a' })).rejects.toThrow(/完全离线/);
    mock.allowed = true;
    mock.account = { context: { uin: '10001' } };
    await expect(caller.start({ expectedInstanceId: 'instance-a' })).rejects.toThrow(
      /关闭当前账号/,
    );
    expect(mock.start).not.toHaveBeenCalled();
  });
  it('停止只按显式请求关闭本实例账号，状态接口不序列化私有来源', async () => {
    const caller = qqRuntimeRouter.createCaller({});
    expect(JSON.stringify(await caller.status())).not.toContain('private-db-key');
    await caller.stop({ expectedInstanceId: 'instance-a', closeAccount: true });
    expect(mock.stop).toHaveBeenCalledOnce();
    expect(mock.clear).toHaveBeenCalledOnce();
  });
  it('官方 QQ 入口由主进程安装发现提供，不接受任意路径', async () => {
    await qqRuntimeRouter.createCaller({}).openOfficial({ expectedInstanceId: 'instance-a' });
    expect(mock.open).toHaveBeenCalledWith('/Applications/QQ.app');
  });
});

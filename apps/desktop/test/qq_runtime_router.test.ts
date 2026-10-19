import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { qqRuntimeRouter } from '../src/main/ipc/routers/qq_runtime';
import type { AccountConfig, AutoEnterTarget } from '@weq/service';

const mock = vi.hoisted(() => ({
  instance: 'instance-a' as string | null,
  mode: 'managed',
  allowed: true,
  policy: 'ask' as 'ask' | 'tray' | 'quit',
  account: null as { context: { uin: string } } | null,
  ready: false,
  target: null as string | null,
  records: [] as AccountConfig[],
  auto: null as AutoEnterTarget | null,
  saveAuto: vi.fn<(value: AutoEnterTarget) => void>(),
  clearAuto: vi.fn(),
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
    get managedStartConfigId() {
      return mock.target;
    },
    set managedStartConfigId(value: string | null) {
      mock.target = value;
    },
    services: { accountConfig: { getRecord: () => (mock.ready ? mock.records[0] : null) } },
    qqRuntime: {
      snapshot: () => ({
        instanceId: mock.instance,
        mode: mock.mode,
        owned: true,
        phase: 'awaiting-login',
        capabilities: { database: mock.ready },
        account: mock.ready ? { uin: '10001', uid: 'u_self' } : null,
      }),
      startManaged: mock.start,
      stop: mock.stop,
      refreshQr: mock.refresh,
      refreshExternal: mock.refreshExternal,
    },
  }),
  requireAttachEnabled: () => {
    if (!mock.allowed) throw new Error('完全离线模式');
  },
  requireBootstrap: () => ({
    userConfig: {
      getSettings: () => ({ autoAttachQq: mock.allowed, windowCloseBehavior: mock.policy }),
      listAccountConfigs: () => mock.records,
      getAutoEnter: () => mock.auto,
      setAutoEnter: mock.saveAuto,
      clearAutoEnter: mock.clearAuto,
    },
  }),
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
  mock.policy = 'ask';
  mock.account = null;
  mock.ready = false;
  mock.target = null;
  mock.records = [];
  mock.auto = null;
  mock.managed = { instanceId: 'instance-a', dbKey: 'private-db-key' };
});
afterEach(() => vi.unstubAllGlobals());
describe('QQ 运行时 IPC 绑定', () => {
  it('关闭策略反映当前全局偏好，不另建冲突的托管设置', async () => {
    const caller = qqRuntimeRouter.createCaller({});
    expect((await caller.status()).closeBehavior).toBe('ask');
    mock.policy = 'tray';
    expect((await caller.status()).closeBehavior).toBe('tray');
  });
  it('保存配置启动校验来源与账号，拒绝同号之外的配置替换', async () => {
    const caller = qqRuntimeRouter.createCaller({});
    mock.records = [
      {
        configId: 'owned-config',
        uin: '10001',
        dbKey: 'fixture',
        algos: {},
        lastLoginAt: 1,
        managed: true,
        dataDir: '/fixture/owned',
      },
    ];
    await expect(
      caller.start({
        expectedInstanceId: 'instance-a',
        uin: '10002',
        expectedAccountConfigId: 'owned-config',
      }),
    ).rejects.toThrow(/配置已变化/);
    expect(mock.start).not.toHaveBeenCalled();
    await caller.start({
      expectedInstanceId: 'instance-a',
      expectedAccountConfigId: 'owned-config',
    });
    expect(mock.start).toHaveBeenCalledWith('10001');
    expect(mock.target).toBe('owned-config');
  });
  it('自动进入偏好只接受已打开的本实例，不清除另一数据源的默认目标', async () => {
    const caller = qqRuntimeRouter.createCaller({});
    await expect(
      caller.setAutoEnter({ expectedInstanceId: 'instance-a', enabled: true }),
    ).rejects.toThrow(/尚未就绪/);
    mock.ready = true;
    mock.account = { context: { uin: '10001' } };
    mock.records = [
      {
        configId: 'owned-config',
        uin: '10001',
        dbKey: 'fixture',
        algos: {},
        lastLoginAt: 1,
        managed: true,
        dataDir: '/fixture/owned',
      },
    ];
    await caller.setAutoEnter({ expectedInstanceId: 'instance-a', enabled: true });
    expect(mock.saveAuto).toHaveBeenCalledWith({
      configId: 'owned-config',
      uin: '10001',
      dataDir: '/fixture/owned',
    });
    mock.auto = { configId: 'another-source', uin: '10001' };
    await caller.setAutoEnter({ expectedInstanceId: 'instance-a', enabled: false });
    expect(mock.clearAuto).not.toHaveBeenCalled();
    await expect(
      caller.setAutoEnter({ expectedInstanceId: 'old-instance', enabled: true }),
    ).rejects.toThrow(/已切换/);
  });
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

// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { bootstrapRouter } from '../src/main/ipc/routers/bootstrap';

const mock = vi.hoisted(() => ({
  configured: false,
  sourceRunningPids: [] as number[],
  runningPids: [] as number[],
  pid: null as number | null,
  perform: vi.fn(),
  launch: vi.fn(),
  restart: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({
  requirePlatform: () => ({ kind: 'darwin', resolveQqPid: () => mock.pid }),
  getAppContext: () => ({
    account: { context: { uin: '10001' } },
    services: {
      accountConfig: { getRecord: () => ({ qqOnline: mock.pid !== null, qqPid: mock.pid }) },
    },
  }),
}));
vi.mock('../src/main/qq_debug_copy', () => ({
  QqDebugCopyManager: class {
    executablePath = '/fixture/QQ-WeQ.app/Contents/MacOS/QQ';
    async isConfigured() {
      return mock.configured;
    }
    async status() {
      return {
        phase: 'idle',
        sourceRunningPids: mock.sourceRunningPids,
        runningPids: mock.runningPids,
      };
    }
    perform = mock.perform;
  },
}));
vi.mock('../src/main/qq_launch', () => ({
  launchQq: mock.launch,
  restartQq: mock.restart,
  qqRestartInProgress: () => false,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mock.configured = true;
  mock.sourceRunningPids = [];
  mock.runningPids = [];
  mock.pid = null;
});

it('代理菜单默认打开已配置的调试副本', async () => {
  const caller = bootstrapRouter.createCaller({});
  await caller.launchQq();
  expect(mock.perform).toHaveBeenCalledWith('open');
  expect(mock.launch).not.toHaveBeenCalled();
});

it('未配置副本时，打开 QQ 沿用宿主安装', async () => {
  mock.configured = false;
  await bootstrapRouter.createCaller({}).launchQq();
  expect(mock.launch).toHaveBeenCalledOnce();
  expect(mock.perform).not.toHaveBeenCalled();
});

it('登录其他账号打开新副本，普通打开仍会唤起现有副本', async () => {
  mock.runningPids = [51];
  const caller = bootstrapRouter.createCaller({});
  await caller.launchQq();
  expect(mock.perform).toHaveBeenLastCalledWith('activate');
  await caller.launchQq({ newInstance: true });
  expect(mock.perform).toHaveBeenLastCalledWith('open');
  expect(mock.restart).not.toHaveBeenCalled();
});

it('未配置副本时，向宿主上的 QQ 请求打开新实例', async () => {
  mock.configured = false;
  await bootstrapRouter.createCaller({}).launchQq({ newInstance: true });
  expect(mock.launch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'darwin' }), true);
  expect(mock.perform).not.toHaveBeenCalled();
});

it('当前账号登录单个普通 QQ 且副本未运行时可切换', async () => {
  mock.sourceRunningPids = [51];
  mock.pid = 51;
  const caller = bootstrapRouter.createCaller({});
  await expect(caller.getQqProcessState()).resolves.toMatchObject({ switchingToDebugCopy: true });
  await caller.restartQq();
  expect(mock.perform).toHaveBeenCalledWith('switch', 51);
  expect(mock.restart).not.toHaveBeenCalled();
});

it('普通 QQ 和调试副本同时运行时，只重启当前账号所在的调试副本', async () => {
  mock.sourceRunningPids = [51];
  mock.runningPids = [52];
  mock.pid = 52;
  const caller = bootstrapRouter.createCaller({});
  await expect(caller.getQqProcessState()).resolves.toMatchObject({
    canRestart: true,
    switchingToDebugCopy: false,
  });
  await caller.restartQq();
  expect(mock.restart).toHaveBeenCalledOnce();
  expect(mock.restart.mock.calls[0]?.[0].qqExePath()).toContain('QQ-WeQ.app');
  expect(mock.perform).not.toHaveBeenCalled();

  mock.pid = null;
  await expect(caller.getQqProcessState()).resolves.toMatchObject({
    running: true,
    canRestart: false,
  });
  await expect(caller.restartQq()).rejects.toThrow('尚未检测到当前账号登录');
  expect(mock.restart).toHaveBeenCalledOnce();
});

// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { bootstrapRouter } from '../src/main/ipc/routers/bootstrap';

const mock = vi.hoisted(() => ({
  configured: false,
  sourceRunningPids: [] as number[],
  runningPids: [] as number[],
  perform: vi.fn(),
  launch: vi.fn(),
  restart: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({
  requirePlatform: () => ({ kind: 'darwin' }),
  getAppContext: () => ({ account: { context: { uin: '10001' } } }),
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
  expect(mock.launch).toHaveBeenCalledWith({ kind: 'darwin' }, true);
  expect(mock.perform).not.toHaveBeenCalled();
});

it('普通 QQ 运行时通过副本管理器切换', async () => {
  mock.sourceRunningPids = [51];
  const caller = bootstrapRouter.createCaller({});
  await expect(caller.getQqProcessState()).resolves.toMatchObject({ switchingToDebugCopy: true });
  await caller.restartQq();
  expect(mock.perform).toHaveBeenCalledWith('switch');
  expect(mock.restart).not.toHaveBeenCalled();
});

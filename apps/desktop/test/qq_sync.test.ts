import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  app: { isPackaged: false, getAppPath: () => 'D:/fixture/WeQ/apps/desktop' },
  enqueue: vi.fn(),
  stop: vi.fn(async () => {}),
  start: vi.fn(),
  load: vi.fn(),
  log: vi.fn(),
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!;
vi.mock('electron', () => ({ app: fixtures.app }));
vi.mock('../src/main/qq_sync_loader', () => ({ loadQqSync: fixtures.load }));
vi.mock('@weq/service', () => ({
  getLogger: () => ({ child: () => ({ info: fixtures.log, warn: fixtures.log }) }),
}));

describe('桌面主进程 QQ 同步桥接', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    vi.resetModules();
    fixtures.start.mockReset();
    fixtures.load.mockReset();
    fixtures.load.mockResolvedValue({ startQqSync: fixtures.start });
    fixtures.enqueue.mockReset();
    fixtures.stop.mockClear();
    fixtures.log.mockClear();
    fixtures.app.isPackaged = false;
    fixtures.start.mockReturnValue({ enqueue: fixtures.enqueue, stop: fixtures.stop });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', architecture);
  });

  it('开发模式从当前项目目录定位组件，重复启动只安装一次，转交账号守卫并在退出停止', async () => {
    const { startDesktopQqSync, stopDesktopQqSync } = await import('../src/main/qq_sync');
    const { electronHost } = await import('../src/main/host');
    expect(electronHost.syncPrivateTextSent).toBeUndefined();
    await Promise.all([startDesktopQqSync(), startDesktopQqSync()]);
    expect(fixtures.start).toHaveBeenCalledTimes(1);
    expect(fixtures.start.mock.calls[0][0].root.replaceAll('\\', '/')).toBe(
      'D:/fixture/WeQ/native/qq-sync',
    );
    const receipt = {
      pid: 42,
      selfUid: 'u_fixture_self',
      peerUid: 'u_fixture_peer',
      clientSequence: 1,
      timestamp: 1793940000,
    };
    const guard = () => true;
    electronHost.syncPrivateTextSent?.(receipt, guard);
    expect(fixtures.enqueue).toHaveBeenCalledWith(receipt, guard);
    await stopDesktopQqSync();
    expect(electronHost.syncPrivateTextSent).toBeUndefined();
    expect(fixtures.stop).toHaveBeenCalledTimes(1);
    expect(fixtures.enqueue).toHaveBeenCalledTimes(1);
  });

  it('辅助组件缺失不会使应用启动或发送失败，不输出异常内容', async () => {
    fixtures.start.mockImplementation(() => {
      throw new Error('private fixture detail');
    });
    const { startDesktopQqSync } = await import('../src/main/qq_sync');
    await expect(startDesktopQqSync()).resolves.toBeUndefined();
    const { electronHost } = await import('../src/main/host');
    expect(electronHost.syncPrivateTextSent).toBeUndefined();
    expect(JSON.stringify(fixtures.log.mock.calls)).not.toContain('private fixture detail');
  });

  it('记录补取和页面通知结果，同时省略消息内容与账号标识', async () => {
    const { startDesktopQqSync } = await import('../src/main/qq_sync');
    await startDesktopQqSync();
    fixtures.start.mock.calls[0][0].report({
      state: 'lookup-finished',
      jobId: 2,
      attempt: 5,
      retryDelayMs: 4000,
      resultCode: 0,
      returned: 1,
      recordFound: true,
      retryable: false,
      lookupSource: 'server-sequence',
      notifyState: 'dispatched',
      notifyCount: 1,
      readState: 'already-read',
      selfUid: 'u_private_fixture',
      text: 'private fixture message',
    });
    expect(fixtures.log).toHaveBeenCalledWith(
      'QQ 本机同步状态',
      expect.objectContaining({
        event: 'qq-local-sync',
        state: 'lookup-finished',
        jobId: 2,
        attempt: 5,
        retryDelayMs: 4000,
        resultCode: 0,
        returned: 1,
        recordFound: true,
        retryable: false,
        lookupSource: 'server-sequence',
        notifyState: 'dispatched',
        notifyCount: 1,
        readState: 'already-read',
      }),
    );
    expect(JSON.stringify(fixtures.log.mock.calls)).not.toContain('private_fixture');
    expect(JSON.stringify(fixtures.log.mock.calls)).not.toContain('private fixture message');
  });

  it('组件加载期间退出会等待加载结束并关闭运行实例', async () => {
    let resolveLoad: (value: { startQqSync: typeof fixtures.start }) => void = () => {};
    fixtures.load.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const sync = await import('../src/main/qq_sync');
    const starting = sync.startDesktopQqSync();
    const stopping = sync.stopDesktopQqSync();
    resolveLoad({ startQqSync: fixtures.start });
    await Promise.all([starting, stopping]);
    expect(fixtures.stop).toHaveBeenCalledTimes(1);
    expect(sync.getPrivateTextSentHandler()).toBeUndefined();
  });

  it('其他平台不加载 Windows 桥接', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const sync = await import('../src/main/qq_sync');
    await sync.startDesktopQqSync();
    expect(fixtures.load).not.toHaveBeenCalled();
  });
});

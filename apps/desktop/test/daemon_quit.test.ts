// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  run: vi.fn(),
  spawn: vi.fn(),
  ping: vi.fn(),
  stop: vi.fn(),
  httpStart: vi.fn(),
  write: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return {
    execFile: Object.assign(vi.fn(), { [promisify.custom]: fixture.run }),
    spawn: fixture.spawn,
  };
});
vi.mock('node:fs', () => ({ existsSync: () => true }));
vi.mock('node:fs/promises', () => ({
  chmod: fixture.write,
  copyFile: fixture.write,
  mkdir: fixture.write,
  rename: fixture.write,
  rm: fixture.write,
}));
vi.mock('@weq/service', () => ({
  DAEMON_PIPE_NAME: 'weq-daemon',
  getLogger: () => ({ child: () => fixture.logger }),
  getHost: () => ({ canAutostart: false }),
  pingDaemon: fixture.ping,
  daemonStop: fixture.stop,
  daemonHttpStart: fixture.httpStart,
  callDaemon: vi.fn(),
  daemonAutostartSet: vi.fn(),
  daemonAutostartStatus: vi.fn(),
}));
vi.mock('../src/main/resource', () => ({ resolveResource: () => '/synthetic/weq-daemon' }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.run.mockReset().mockResolvedValue({ stdout: 'weq-daemon 1.0.0' });
  fixture.ping.mockReset().mockResolvedValue(null);
  fixture.stop.mockReset().mockResolvedValue(false);
  fixture.spawn.mockReturnValue({ unref: vi.fn() });
  vi.stubEnv('WEQ_DAEMON_DIR', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('退出时停止守护进程', () => {
  it.runIf(process.platform === 'darwin')(
    '先 bootout 本轮服务再停止管道，不删除自启或业务记忆',
    async () => {
      const { stopDaemonForAppQuit } = await import('../src/main/daemon/runtime');
      await stopDaemonForAppQuit();
      expect(fixture.run).toHaveBeenCalledWith(
        '/bin/launchctl',
        ['bootout', `gui/${process.getuid()}/weq-daemon`],
        { timeout: 3000 },
      );
      expect(fixture.run.mock.invocationCallOrder[0]).toBeLessThan(
        fixture.stop.mock.invocationCallOrder[0]!,
      );
      expect(fixture.stop).toHaveBeenCalledWith('weq-daemon');
      expect(fixture.write).not.toHaveBeenCalled();
      expect(fixture.spawn).not.toHaveBeenCalled();
    },
  );

  it('没有加载 LaunchAgent 时仍停止独立守护进程，重复调用只停止一次', async () => {
    fixture.run.mockRejectedValue(new Error('合成未加载服务'));
    const { stopDaemonForAppQuit } = await import('../src/main/daemon/runtime');
    await Promise.all([stopDaemonForAppQuit(), stopDaemonForAppQuit()]);
    expect(fixture.stop).toHaveBeenCalledOnce();
  });

  it('停止命令之后继续等管道消失，不能只发送后就结束退出清理', async () => {
    fixture.stop.mockResolvedValue(true);
    fixture.ping.mockResolvedValueOnce({ version: '1.0.0' }).mockResolvedValueOnce(null);
    const { stopDaemonForAppQuit } = await import('../src/main/daemon/runtime');
    await stopDaemonForAppQuit();
    expect(fixture.ping).toHaveBeenCalledTimes(2);
    expect(fixture.logger.warn).not.toHaveBeenCalled();
  });

  it('启动探测未完成便退出时不再拉起后台，退出后也不能重新启动', async () => {
    vi.stubEnv('WEQ_DAEMON_DIR', '/synthetic');
    let finish = (_result: { stdout: string }) => {};
    fixture.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { ensureDaemonRunning, stopDaemonForAppQuit, startDaemonHttp } = await import(
      '../src/main/daemon/runtime'
    );
    const starting = ensureDaemonRunning();
    const stopping = stopDaemonForAppQuit();
    expect(fixture.stop).not.toHaveBeenCalled();
    finish({ stdout: 'weq-daemon 1.0.0' });
    expect(await starting).toBe(false);
    await stopping;
    expect(await ensureDaemonRunning()).toBe(false);
    expect((await startDaemonHttp(17690, '/synthetic/cards')).ok).toBe(false);
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.httpStart).not.toHaveBeenCalled();
    expect(fixture.stop).toHaveBeenCalledOnce();
  });

  it('已经拉起但尚未就绪时退出，终止后续启动重试并等待停止完成', async () => {
    vi.stubEnv('WEQ_DAEMON_DIR', '/synthetic');
    const { ensureDaemonRunning, stopDaemonForAppQuit } = await import(
      '../src/main/daemon/runtime'
    );
    const starting = ensureDaemonRunning();
    await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce());
    const stopping = stopDaemonForAppQuit();
    expect(await starting).toBe(false);
    await stopping;
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(fixture.stop).toHaveBeenCalledOnce();
  });
});

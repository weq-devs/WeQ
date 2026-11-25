// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { launchQq, restartQq } from '../src/main/qq_launch';

const f = vi.hoisted(() => ({
  exists: vi.fn(() => true),
  spawn: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock('node:fs', () => ({ existsSync: f.exists, default: { existsSync: f.exists } }));
vi.mock('node:child_process', () => ({
  spawn: f.spawn,
  execFile: f.execFile,
  default: { spawn: f.spawn, execFile: f.execFile },
}));

beforeEach(() => {
  vi.clearAllMocks();
  f.exists.mockReturnValue(true);
});

describe('启动已安装的 QQ', () => {
  it.each([
    [undefined, ['-a', '/Applications/QQ Test.app']],
    [true, ['-n', '-a', '/Applications/QQ Test.app']],
  ])(
    'macOS 通过 LaunchServices 打开应用（请求新实例：%s），路径含空格也不经 shell',
    async (newInstance, args) => {
      const exe = '/Applications/QQ Test.app/Contents/MacOS/QQ';
      f.execFile.mockImplementation((_command, _args, _options, callback) => callback(null));
      await launchQq({ kind: 'darwin', qqExePath: () => exe }, newInstance);
      expect(f.execFile).toHaveBeenCalledWith(
        '/usr/bin/open',
        args,
        { timeout: 10_000, env: expect.any(Object) },
        expect.any(Function),
      );
      expect(f.spawn).not.toHaveBeenCalled();
    },
  );
  it.each(['linux', 'win32'] as const)('%s 启动独立进程，不等待 QQ 退出', async (kind) => {
    const exe = kind === 'win32' ? 'C:\\Program Files\\QQ\\QQ.exe' : '/opt/QQ Test/qq';
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    f.spawn.mockReturnValue(child);
    const launched = launchQq({ kind, qqExePath: () => exe });
    expect(child.unref).not.toHaveBeenCalled();
    child.emit('spawn');
    await launched;
    expect(f.spawn).toHaveBeenCalledWith(exe, [], {
      detached: true,
      stdio: 'ignore',
      cwd: kind === 'win32' ? 'C:\\Program Files\\QQ' : '/opt/QQ Test',
      env: expect.any(Object),
    });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(f.execFile).not.toHaveBeenCalled();
  });
  it.each(['linux', 'darwin'] as const)(
    '%s 不继承 Electron 的 Node 运行开关，也不修改宿主环境',
    async (kind) => {
      vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
      try {
        const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
        f.spawn.mockReturnValue(child);
        f.execFile.mockImplementation((_command, _args, _options, callback) => callback(null));
        const launched = launchQq({
          kind,
          qqExePath: () =>
            kind === 'darwin' ? '/Applications/QQ.app/Contents/MacOS/QQ' : '/opt/QQ/qq',
        });
        if (kind === 'linux') child.emit('spawn');
        await launched;
        const options =
          kind === 'darwin' ? f.execFile.mock.calls[0]![2] : f.spawn.mock.calls[0]![2];
        expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(process.env.ELECTRON_RUN_AS_NODE).toBe('1');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  it.each([null, '/missing/QQ'])('安装路径缺失时不启动任何程序：%s', async (exe) => {
    f.exists.mockReturnValue(false);
    await expect(launchQq({ kind: 'darwin', qqExePath: () => exe })).rejects.toThrow(
      '未检测到 QQ 安装',
    );
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.execFile).not.toHaveBeenCalled();
  });
  it('系统拒绝启动时透传错误，不当作成功', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    f.spawn.mockReturnValue(child);
    const launched = launchQq({ kind: 'linux', qqExePath: () => '/opt/QQ/qq' });
    const rejected = expect(launched).rejects.toThrow('EACCES');
    child.emit('error', new Error('EACCES'));
    await rejected;
    expect(child.unref).not.toHaveBeenCalled();
  });
  it('macOS 打开失败时返回系统错误', async () => {
    f.execFile.mockImplementation((_command, _args, _options, callback) =>
      callback(new Error('启动被拒绝')),
    );
    await expect(
      launchQq({ kind: 'darwin', qqExePath: () => '/Applications/QQ.app/Contents/MacOS/QQ' }),
    ).rejects.toThrow('启动被拒绝');
  });
});

describe('重新启动 QQ', () => {
  const normal = '/Applications/QQ.app/Contents/MacOS/QQ';
  const debug = '/Users/test/Applications/QQ-WeQ.app/Contents/MacOS/QQ';

  it('结束当前账号的调试副本，确认旧进程退出后重开同一副本', async () => {
    let running = true;
    const stopRequested = Promise.withResolvers<void>();
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') stopRequested.resolve();
      if (signal === 0 && !running) throw Object.assign(new Error(), { code: 'ESRCH' });
      return true;
    });
    f.execFile.mockImplementation((command, _args, _options, callback) => {
      if (command === '/bin/ps') callback(null, ` 1234 ${normal}\n 2345 ${debug}\n`);
      else callback(null);
    });
    const request = restartQq(
      { kind: 'darwin', qqExePath: () => normal, resolveQqPid: () => 2345 },
      '10001',
      debug,
    );
    try {
      await Promise.race([stopRequested.promise, request]);
      expect(kill).toHaveBeenCalledWith(2345, 'SIGTERM');
      expect(kill).not.toHaveBeenCalledWith(1234, 'SIGTERM');
      expect(f.execFile).toHaveBeenCalledTimes(1);
      running = false;
      await request;
      expect(f.execFile).toHaveBeenLastCalledWith(
        '/usr/bin/open',
        ['-a', '/Users/test/Applications/QQ-WeQ.app'],
        expect.any(Object),
        expect.any(Function),
      );
    } finally {
      running = false;
      await request.catch(() => undefined);
      kill.mockRestore();
    }
  });

  it.each([
    [` 1234 ${normal}\n`, '没有找到可重新启动的 QQ 进程'],
    [` 1234 ${normal}\n 2345 ${debug}\n`, '检测到多个 QQ 实例'],
  ])('当前账号的进程无法确认时，不结束任何进程（%s）', async (processes, message) => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    f.execFile.mockImplementation((_command, _args, _options, callback) =>
      callback(null, processes),
    );
    try {
      await expect(
        restartQq(
          { kind: 'darwin', qqExePath: () => normal, resolveQqPid: () => null },
          '10001',
          debug,
        ),
      ).rejects.toThrow(message);
      expect(kill).not.toHaveBeenCalled();
      expect(f.execFile).toHaveBeenCalledTimes(1);
    } finally {
      kill.mockRestore();
    }
  });
});

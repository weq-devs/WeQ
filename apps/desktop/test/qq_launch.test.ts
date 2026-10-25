// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { launchQq } from '../src/main/qq_launch';

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
  it('macOS 通过 LaunchServices 打开检测到的应用，路径含空格也不经 shell', async () => {
    const exe = '/Applications/QQ Test.app/Contents/MacOS/QQ';
    f.execFile.mockImplementation((_command, _args, _options, callback) => callback(null));
    await launchQq({ kind: 'darwin', qqExePath: () => exe });
    expect(f.execFile).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-a', '/Applications/QQ Test.app'],
      { timeout: 10_000, env: expect.any(Object) },
      expect.any(Function),
    );
    expect(f.spawn).not.toHaveBeenCalled();
  });
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

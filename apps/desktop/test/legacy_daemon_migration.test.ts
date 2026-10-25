// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retireLegacyDaemon } from '../src/main/legacy_daemon';

const fixture = vi.hoisted(() => ({ stop: vi.fn(), ping: vi.fn() }));
vi.mock('@weq/service', () => ({ daemonStop: fixture.stop, pingDaemon: fixture.ping }));
let home: string;
const run = vi.fn();
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'weq-legacy-retirement-'));
  run.mockReset().mockResolvedValue({ stdout: '' });
  fixture.stop.mockReset().mockResolvedValue(true);
  fixture.ping.mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
describe('旧后台入口退役', () => {
  it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
    '当前 GUI 仍由旧后台启动时不强拆，避免连带结束当前应用',
    async () => {
      run.mockResolvedValue({ stdout: '/synthetic/weq-daemon\n' });
      await expect(
        retireLegacyDaemon({ platform: process.platform, home, env: {}, run }),
      ).rejects.toThrow('系统启动器');
      expect(fixture.stop).not.toHaveBeenCalled();
      expect(
        run.mock.calls.some(([, args]) => args.includes('bootout') || args.includes('disable')),
      ).toBe(false);
    },
  );
  it('macOS 的旧 GUI 一次性登录项只删除入口，不 bootout 当前 GUI', async () => {
    const agents = join(home, 'Library', 'LaunchAgents');
    await mkdir(agents, { recursive: true });
    const path = join(agents, 'weq-daemon-gui.plist');
    await writeFile(path, '<synthetic plist>');
    run.mockImplementation(async (command: string) => ({
      stdout:
        command === '/usr/bin/plutil'
          ? JSON.stringify({ Label: 'weq-daemon-gui', ProgramArguments: ['/synthetic/WeQ'] })
          : '',
    }));
    await retireLegacyDaemon({ platform: 'darwin', home, env: {}, uid: 98765, run });
    await expect(access(path)).rejects.toThrow();
    expect(run.mock.calls.some(([, args]) => args.includes('bootout'))).toBe(false);
  });
  it('macOS 卸载并删除旧注册，保留数据；只处理两个固定 label', async () => {
    const agents = join(home, 'Library', 'LaunchAgents');
    await mkdir(agents, { recursive: true });
    const path = join(agents, 'weq-daemon.plist');
    await writeFile(path, '<synthetic plist>');
    await writeFile(join(agents, 'unrelated.plist'), 'untouched');
    const data = join(home, 'old-state.json');
    await writeFile(data, 'retained');
    run.mockImplementation(async (command: string) => ({
      stdout:
        command === '/usr/bin/plutil'
          ? JSON.stringify({
              Label: 'weq-daemon',
              ProgramArguments: ['/synthetic/weq-daemon', 'serve'],
            })
          : '',
    }));
    await retireLegacyDaemon({ platform: 'darwin', home, env: {}, uid: 98765, run });
    expect(run).toHaveBeenCalledWith('/bin/launchctl', ['bootout', 'gui/98765/weq-daemon']);
    await expect(access(path)).rejects.toThrow();
    expect(await readFile(data, 'utf8')).toBe('retained');
    expect(await readFile(join(agents, 'unrelated.plist'), 'utf8')).toBe('untouched');
    expect(fixture.stop).toHaveBeenCalledOnce();
  });
  it('卸载失败且服务仍加载时不删除注册或冒称退役成功', async () => {
    const agents = join(home, 'Library', 'LaunchAgents');
    await mkdir(agents, { recursive: true });
    const path = join(agents, 'weq-daemon.plist');
    await writeFile(path, 'retained');
    run.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === '-convert')
        return {
          stdout: JSON.stringify({ Label: 'weq-daemon', ProgramArguments: ['/weq-daemon'] }),
        };
      if (args[0] === 'bootout') throw new Error('synthetic denied');
      return { stdout: 'loaded' };
    });
    await expect(
      retireLegacyDaemon({ platform: 'darwin', home, env: {}, uid: 98765, run }),
    ).rejects.toThrow('denied');
    expect(await readFile(path, 'utf8')).toBe('retained');
    expect(fixture.stop).not.toHaveBeenCalled();
  });
  it('Linux 只停用旧 WeQ unit，不关闭共享 linger，也不注册新服务', async () => {
    const directory = join(home, '.config', 'systemd', 'user');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'weq-daemon.service'),
      '[Service]\nExecStart=/weq-daemon serve\n',
    );
    await retireLegacyDaemon({ platform: 'linux', home, env: {}, run });
    expect(
      run.mock.calls.filter(([command, args]) => command === 'systemctl' && !args.includes('show')),
    ).toEqual([
      ['systemctl', ['--user', 'disable', '--now', 'weq-daemon.service']],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
  });
  it('Windows 查询失败不能把权限错误直接当成任务不存在', async () => {
    const denied = Object.assign(new Error('synthetic denied'), { code: 1 });
    run.mockImplementation(async (command: string) => {
      if (command.endsWith('powershell.exe'))
        return { stdout: JSON.stringify([{ TaskName: 'weq-daemon', TaskPath: '\\' }]) };
      throw denied;
    });
    await expect(retireLegacyDaemon({ platform: 'win32', home, env: {}, run })).rejects.toThrow(
      'denied',
    );
    expect(fixture.stop).not.toHaveBeenCalled();
  });
  it('Windows 经系统列表确认任务不存在后可继续，无需旧二进制', async () => {
    run.mockImplementation(async (command: string) => {
      if (command.endsWith('powershell.exe')) return { stdout: '[]' };
      throw Object.assign(new Error('synthetic absent'), { code: 1 });
    });
    await retireLegacyDaemon({ platform: 'win32', home, env: {}, run });
    expect(run.mock.calls.some(([, args]) => args.includes('/Delete'))).toBe(false);
    expect(fixture.stop).toHaveBeenCalledOnce();
  });
});

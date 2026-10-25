// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppAutostart } from '../src/main/autostart';
import { AUTOSTART_ARG } from '../src/main/startup_window';

let root: string;
let nativeEnabled = false;
const native = { get: vi.fn(), set: vi.fn() };
const run = vi.fn();
const stopLegacy = vi.fn();
function controller(platform: NodeJS.Platform = 'darwin', supported = true) {
  return new AppAutostart({
    platform,
    home: root,
    env: {},
    configDir: join(root, 'app'),
    exePath: '/Applications/WeQ.app/Contents/MacOS/WeQ',
    supported,
    native,
    run,
    stopLegacy,
  });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'weq-autostart-'));
  nativeEnabled = false;
  native.get.mockReset().mockImplementation(() => ({
    openAtLogin: nativeEnabled,
    status: nativeEnabled ? 'enabled' : 'not-registered',
  }));
  native.set.mockReset().mockImplementation(({ openAtLogin }: { openAtLogin: boolean }) => {
    nativeEnabled = openAtLogin;
  });
  run.mockReset().mockResolvedValue({ stdout: '' });
  stopLegacy.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe('不依赖 daemon 的系统登录项', () => {
  it('macOS 直接注册应用，读取系统真实状态，关闭后不启动任何辅助进程', async () => {
    const startup = controller();
    expect((await startup.status()).enabled).toBe(false);
    expect((await startup.set(true)).enabled).toBe(true);
    expect(native.set).toHaveBeenCalledWith({ openAtLogin: true });
    expect((await startup.set(false)).enabled).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(stopLegacy).not.toHaveBeenCalled();
  });
  it('系统要求批准时明确返回待批准，不冒称已经生效', async () => {
    native.get.mockReturnValue({ openAtLogin: false, status: 'requires-approval' });
    const state = await controller().set(true);
    expect(state.enabled).toBe(false);
    expect(state.requiresApproval).toBe(true);
  });
  it('Windows 读写同一安装路径和参数，尊重任务管理器禁用状态', async () => {
    const startup = controller('win32');
    await startup.set(true);
    expect(native.set).toHaveBeenCalledWith({
      openAtLogin: true,
      path: '/Applications/WeQ.app/Contents/MacOS/WeQ',
      args: [AUTOSTART_ARG],
      name: 'app.weq.desktop',
    });
    expect(native.get).toHaveBeenCalledWith({
      path: '/Applications/WeQ.app/Contents/MacOS/WeQ',
      args: [AUTOSTART_ARG],
    });
    native.get.mockReturnValue({ openAtLogin: true, executableWillLaunchAtLogin: false });
    expect((await startup.status()).enabled).toBe(false);
  });
  it('Linux 仅写桌面登录项，转义路径及百分号，不配置 systemd 常驻重启', async () => {
    const startup = new AppAutostart({
      platform: 'linux',
      home: root,
      env: { APPIMAGE: '/opt/We Q/100%.AppImage', XDG_CONFIG_HOME: join(root, 'xdg') },
      configDir: join(root, 'app'),
      exePath: '/tmp/.mount/x',
      supported: true,
      native,
      run,
      stopLegacy,
    });
    await startup.set(true);
    const text = await readFile(join(root, 'xdg', 'autostart', 'app.weq.desktop.desktop'), 'utf8');
    expect(text).toContain('Exec="/opt/We Q/100%%.AppImage"');
    expect(text).toContain(`--no-sandbox ${AUTOSTART_ARG}`);
    expect(text).not.toContain('Restart=');
    expect((await startup.status()).enabled).toBe(true);
    await startup.set(false);
    expect((await startup.status()).enabled).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it('Windows 升级无标记的已启用登录项，但不重新启用任务管理器禁用项', async () => {
    let marked = false;
    native.get.mockImplementation((options: { args?: string[] }) => ({
      openAtLogin: options?.args?.includes(AUTOSTART_ARG) ? marked : !marked,
      executableWillLaunchAtLogin: true,
    }));
    native.set.mockImplementation(({ args }: { args: string[] }) => {
      marked = args.includes(AUTOSTART_ARG);
    });
    const startup = controller('win32');
    expect((await startup.status()).enabled).toBe(true);
    await startup.migrateLegacy();
    expect(marked).toBe(true);
    expect(native.set).toHaveBeenCalledWith(expect.objectContaining({ args: [AUTOSTART_ARG] }));
    native.set.mockClear();
    native.get.mockImplementation((options: { args?: string[] }) => ({
      openAtLogin: !options?.args?.includes(AUTOSTART_ARG),
      executableWillLaunchAtLogin: false,
    }));
    await startup.migrateLegacy();
    expect(native.set).not.toHaveBeenCalled();
    expect((await startup.status()).enabled).toBe(false);
  });
  it('Linux 已有无标记自启项升级后带标记，隐藏禁用项不被重新启用', async () => {
    const startup = controller('linux');
    await startup.set(true);
    const path = join(root, '.config', 'autostart', 'app.weq.desktop.desktop');
    const text = (await readFile(path, 'utf8')).replace(` ${AUTOSTART_ARG}`, '');
    await writeFile(path, text);
    await startup.migrateLegacy();
    expect(await readFile(path, 'utf8')).toContain(` ${AUTOSTART_ARG}`);
    await writeFile(path, `${text}Hidden=true\n`);
    await startup.migrateLegacy();
    expect(await readFile(path, 'utf8')).toBe(`${text}Hidden=true\n`);
    expect((await startup.status()).enabled).toBe(false);
  });
  it('开发态不注册登录项，也不迁移或停止日常 daemon', async () => {
    const startup = controller('darwin', false);
    await startup.migrateLegacy();
    expect((await startup.status()).supported).toBe(false);
    await expect(startup.set(true)).rejects.toThrow('安装版');
    expect(native.set).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(stopLegacy).not.toHaveBeenCalled();
  });
  it('Linux 对 Exec 的两层转义遵循 XDG，拒绝规范不允许的等号路径', async () => {
    const options = {
      platform: 'linux' as const,
      home: root,
      env: { APPIMAGE: '/opt/a\\b"$`/WeQ.AppImage' },
      configDir: join(root, 'app'),
      exePath: '/unused',
      supported: true,
      native,
      run,
      stopLegacy,
    };
    await new AppAutostart(options).set(true);
    const text = await readFile(
      join(root, '.config', 'autostart', 'app.weq.desktop.desktop'),
      'utf8',
    );
    expect(text).toContain(
      `a${'\\'.repeat(4)}b${'\\'.repeat(2)}"${'\\'.repeat(2)}$${'\\'.repeat(2)}\``,
    );
    await expect(
      new AppAutostart({ ...options, env: { APPIMAGE: '/opt/a=b/WeQ' } }).set(true),
    ).rejects.toThrow('路径无效');
  });
});
describe('旧后台配置迁移', () => {
  async function legacy(enabled: boolean) {
    const directory = join(root, 'Library', 'Application Support', 'weq-daemon');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'weq-daemon.gui.json'),
      JSON.stringify({ version: 1, enabled, gui_exe: '/old/WeQ' }),
    );
    return directory;
  }
  it('先保留旧自启选择，再停用旧后台；重复启动不覆盖用户后来关闭的登录项', async () => {
    const directory = await legacy(true);
    const startup = controller();
    await startup.migrateLegacy();
    expect(native.set).toHaveBeenCalledOnce();
    expect(nativeEnabled).toBe(true);
    expect(stopLegacy).toHaveBeenCalledOnce();
    expect(native.set.mock.invocationCallOrder[0]).toBeLessThan(
      stopLegacy.mock.invocationCallOrder[0]!,
    );
    await access(join(directory, 'weq-daemon.gui.json'));
    nativeEnabled = false;
    await controller().migrateLegacy();
    expect(native.set).toHaveBeenCalledOnce();
    expect(nativeEnabled).toBe(false);
    expect(stopLegacy).toHaveBeenCalledTimes(2);
  });
  it('旧自启关闭不覆盖已有系统登录项；旧后台停止失败可重试且不重复覆盖自启', async () => {
    await legacy(false);
    nativeEnabled = true;
    stopLegacy.mockRejectedValueOnce(new Error('synthetic stop failed'));
    await expect(controller().migrateLegacy()).rejects.toThrow('stop failed');
    await controller().migrateLegacy();
    expect(native.set).not.toHaveBeenCalled();
    expect(nativeEnabled).toBe(true);
    expect(stopLegacy).toHaveBeenCalledTimes(2);
  });
  it('旧设置损坏时报告失败并保留现场，不能先拆掉旧自启', async () => {
    const directory = await legacy(true);
    await writeFile(join(directory, 'weq-daemon.gui.json'), '{broken');
    await expect(controller().migrateLegacy()).rejects.toThrow();
    expect(stopLegacy).not.toHaveBeenCalled();
    expect(native.set).not.toHaveBeenCalled();
  });
});

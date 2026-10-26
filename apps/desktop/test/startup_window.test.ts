import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOSTART_ARG,
  MANUAL_RESTART_ARG,
  installStartupWindowReveal,
  isAutostartLaunch,
  manualRestartArgs,
  shouldShowStartupWindow,
} from '../src/main/startup_window';

afterEach(() => vi.useRealTimers());

class WindowFixture extends EventEmitter {
  webContents = new EventEmitter();
  destroyed = false;
  isDestroyed = () => this.destroyed;
  show = vi.fn();
  restore = vi.fn();
  focus = vi.fn();
  setAlwaysOnTop = vi.fn();
}

describe('系统自启与手动窗口启动边界', () => {
  it('只认显式启动标记或 macOS 的实际登录启动信息，不用是否已注册推测', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(isAutostartLaunch(['/synthetic/WeQ', AUTOSTART_ARG], platform, false)).toBe(true);
      expect(isAutostartLaunch(['/synthetic/WeQ'], platform, false)).toBe(false);
      expect(isAutostartLaunch(['/synthetic/WeQ', `${AUTOSTART_ARG}=false`], platform, false)).toBe(
        false,
      );
    }
    expect(isAutostartLaunch(['/synthetic/WeQ'], 'darwin', true)).toBe(true);
    expect(isAutostartLaunch(['/synthetic/WeQ'], 'win32', true)).toBe(false);
  });
  it('默认关闭时仅自启不显示，手动打开及托盘失败仍能找回窗口', () => {
    const base = {
      autostart: true,
      showWindowOnAutostart: false,
      trayAvailable: true,
      manualRequested: false,
    };
    expect(shouldShowStartupWindow(base)).toBe(false);
    expect(shouldShowStartupWindow({ ...base, autostart: false })).toBe(true);
    expect(shouldShowStartupWindow({ ...base, showWindowOnAutostart: true })).toBe(true);
    expect(shouldShowStartupWindow({ ...base, manualRequested: true })).toBe(true);
    expect(shouldShowStartupWindow({ ...base, trayAvailable: false })).toBe(true);
  });
  it('隐藏自启不因 ready-to-show、加载结束或延迟兜底突然显示', () => {
    vi.useFakeTimers();
    const window = new WindowFixture();
    installStartupWindowReveal(window, false);
    window.emit('ready-to-show');
    window.webContents.emit('did-finish-load');
    vi.advanceTimersByTime(5000);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('普通启动保留原三条显示路径，窗口关闭后撤销延迟兜底', () => {
    vi.useFakeTimers();
    const window = new WindowFixture();
    installStartupWindowReveal(window, true);
    window.emit('ready-to-show');
    window.webContents.emit('did-finish-load');
    vi.advanceTimersByTime(1000);
    expect(window.show).toHaveBeenCalledTimes(3);
    expect(window.focus).toHaveBeenCalledTimes(3);
    const closed = new WindowFixture();
    installStartupWindowReveal(closed, true);
    closed.destroyed = true;
    closed.emit('closed');
    vi.advanceTimersByTime(1000);
    expect(closed.show).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('用户主动重启移除自启标记，保留其他启动参数及脚本路径', () => {
    expect(
      manualRestartArgs([
        '/synthetic/WeQ',
        '/synthetic/app',
        AUTOSTART_ARG,
        '--ozone-platform=x11',
      ]),
    ).toEqual(['/synthetic/app', '--ozone-platform=x11', MANUAL_RESTART_ARG]);
    expect(manualRestartArgs(['/synthetic/WeQ', MANUAL_RESTART_ARG])).toEqual([MANUAL_RESTART_ARG]);
    expect(isAutostartLaunch(['/synthetic/WeQ', MANUAL_RESTART_ARG], 'darwin', true)).toBe(false);
  });
});

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
  it('文档加载和计时器不代表实际绘制，不提前暴露空窗口', () => {
    vi.useFakeTimers();
    const window = new WindowFixture();
    installStartupWindowReveal(window, true);
    window.webContents.emit('did-finish-load');
    vi.advanceTimersByTime(5000);
    expect(window.show).not.toHaveBeenCalled();
    window.emit('ready-to-show');
    expect(window.show).toHaveBeenCalledOnce();
  });
  it.each(['ready-to-show'] as const)(
    '普通启动由 %s 首次显示后，重载不再抢焦点、恢复窗口或置顶',
    (first) => {
      vi.useFakeTimers();
      const window = new WindowFixture();
      installStartupWindowReveal(window, true);
      window.emit(first);

      expect(window.show).toHaveBeenCalledTimes(1);
      expect(window.focus).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(window.listenerCount('ready-to-show')).toBe(0);
      expect(window.webContents.listenerCount('did-finish-load')).toBe(0);

      // 模拟首次加载的其余事件，以及前台、后台、最小化或隐藏时的后续重载。
      for (let reload = 0; reload < 4; reload++) {
        window.emit('ready-to-show');
        window.webContents.emit('did-finish-load');
      }
      vi.advanceTimersByTime(5000);
      expect(window.show).toHaveBeenCalledTimes(1);
      expect(window.restore).toHaveBeenCalledTimes(1);
      expect(window.focus).toHaveBeenCalledTimes(1);
      expect(window.setAlwaysOnTop.mock.calls).toEqual([[true], [false]]);
    },
  );
  it('首次显示前关闭窗口会撤销所有显示回调及延迟兜底', () => {
    vi.useFakeTimers();
    const closed = new WindowFixture();
    installStartupWindowReveal(closed, true);
    closed.destroyed = true;
    closed.emit('closed');
    closed.emit('ready-to-show');
    closed.webContents.emit('did-finish-load');
    vi.advanceTimersByTime(1000);
    expect(closed.show).not.toHaveBeenCalled();
    expect(closed.listenerCount('ready-to-show')).toBe(0);
    expect(closed.webContents.listenerCount('did-finish-load')).toBe(0);
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

export const AUTOSTART_ARG = '--weq-autostart';
export const MANUAL_RESTART_ARG = '--weq-manual-restart';

export function isAutostartLaunch(
  argv: readonly string[],
  platform: NodeJS.Platform,
  wasOpenedAtLogin = false,
): boolean {
  return (
    !argv.includes(MANUAL_RESTART_ARG) &&
    (argv.includes(AUTOSTART_ARG) || (platform === 'darwin' && wasOpenedAtLogin))
  );
}

export function shouldShowStartupWindow(input: {
  autostart: boolean;
  showWindowOnAutostart: boolean;
  trayAvailable: boolean;
  manualRequested: boolean;
}): boolean {
  return (
    !input.autostart || input.showWindowOnAutostart || !input.trayAvailable || input.manualRequested
  );
}

/** 用户主动重启不继承“系统自启”身份；自动切换窗口后端的重启则保留原参数。 */
export function manualRestartArgs(argv: readonly string[]): string[] {
  return [
    ...argv.slice(1).filter((arg) => arg !== AUTOSTART_ARG && arg !== MANUAL_RESTART_ARG),
    MANUAL_RESTART_ARG,
  ];
}

interface StartupWindow {
  isDestroyed(): boolean;
  show(): void;
  restore(): void;
  focus(): void;
  setAlwaysOnTop(value: boolean): void;
  on(event: 'ready-to-show', listener: () => void): unknown;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'ready-to-show' | 'closed', listener: () => void): unknown;
}

/** 启动显示仅执行一次；后续重载不改变窗口的可见、最小化或焦点状态。 */
export function installStartupWindowReveal(win: StartupWindow, showInitially: boolean): void {
  if (!showInitially) return;
  let revealed = false;
  const cleanup = () => {
    win.removeListener('ready-to-show', reveal);
    win.removeListener('closed', cleanup);
  };
  const reveal = () => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    cleanup();
    win.show();
    win.restore();
    win.focus();
    try {
      win.setAlwaysOnTop(true);
      win.setAlwaysOnTop(false);
    } catch {
      // 部分窗口系统不支持置顶，仍保留正常显示与聚焦。
    }
  };
  win.on('ready-to-show', reveal);
  win.once('closed', cleanup);
}

export const AUTOSTART_ARG = '--weq-autostart';

export function isAutostartLaunch(
  argv: readonly string[],
  platform: NodeJS.Platform,
  wasOpenedAtLogin = false,
): boolean {
  return argv.includes(AUTOSTART_ARG) || (platform === 'darwin' && wasOpenedAtLogin);
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
  return argv.slice(1).filter((arg) => arg !== AUTOSTART_ARG);
}

interface StartupWindow {
  isDestroyed(): boolean;
  show(): void;
  restore(): void;
  focus(): void;
  setAlwaysOnTop(value: boolean): void;
  on(event: 'ready-to-show', listener: () => void): unknown;
  once(event: 'closed', listener: () => void): unknown;
  webContents: { on(event: 'did-finish-load', listener: () => void): unknown };
}

/** 隐藏自启不注册任何兜底显示回调，避免加载完成后又弹出窗口。 */
export function installStartupWindowReveal(win: StartupWindow, showInitially: boolean): void {
  if (!showInitially) return;
  const reveal = () => {
    if (win.isDestroyed()) return;
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
  win.webContents.on('did-finish-load', reveal);
  const timer = setTimeout(reveal, 1000);
  win.once('closed', () => clearTimeout(timer));
}

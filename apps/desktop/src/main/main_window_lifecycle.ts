/** Keep every reopen entry point on the same primary window and IPC handler. */
interface PrimaryWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  once(event: 'closed', listener: () => void): unknown;
}

type MainWindowVisibility = Pick<PrimaryWindow, 'isDestroyed' | 'isMinimized'> & {
  isVisible(): boolean;
};

export function shouldRevealMainWindowOnActivation(
  hasVisibleWindows: boolean,
  mainWindows: readonly (MainWindowVisibility | null)[],
): boolean {
  // macOS 的可见窗口也包含工具窗口。只有可见主窗口才需要保留当前窗口顺序。
  return (
    !hasVisibleWindows ||
    !mainWindows.some(
      (window) => window && !window.isDestroyed() && !window.isMinimized() && window.isVisible(),
    )
  );
}

export function createMainWindowLifecycle<W extends PrimaryWindow>(options: {
  canOpen(): boolean;
  getWindow(): W | null;
  setWindow(window: W | null): void;
  createWindow(showInitially: boolean): W;
  attachWindow(window: W): void;
}): { open(options?: { show?: boolean }): W | null } {
  return {
    open({ show = true } = {}) {
      if (!options.canOpen()) return null;
      const current = options.getWindow();
      if (current && !current.isDestroyed()) {
        if (!show) return current;
        if (current.isMinimized()) current.restore();
        current.show();
        current.focus();
        return current;
      }

      const window = options.createWindow(show);
      options.setWindow(window);
      window.once('closed', () => {
        // A late close from an old window must not erase its replacement.
        if (options.getWindow() === window) options.setWindow(null);
      });
      options.attachWindow(window);
      return window;
    },
  };
}

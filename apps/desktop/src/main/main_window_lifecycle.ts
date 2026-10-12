/** Keep every reopen entry point on the same primary window and IPC handler. */
interface PrimaryWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  once(event: 'closed', listener: () => void): unknown;
}

export function createMainWindowLifecycle<W extends PrimaryWindow>(options: {
  canOpen(): boolean;
  getWindow(): W | null;
  setWindow(window: W | null): void;
  createWindow(): W;
  attachWindow(window: W): void;
}): { open(): W | null } {
  return {
    open() {
      if (!options.canOpen()) return null;
      const current = options.getWindow();
      if (current && !current.isDestroyed()) {
        if (current.isMinimized()) current.restore();
        current.show();
        current.focus();
        return current;
      }

      const window = options.createWindow();
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

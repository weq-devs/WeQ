import { BrowserWindow, screen } from 'electron';
import { WINDOW_LAYOUTS } from './window_layout';

const windows = new WeakMap<BrowserWindow, BrowserWindow>();

export function getBootstrapSettingsWindow(owner: BrowserWindow | null): BrowserWindow | null {
  const win = owner && windows.get(owner);
  return win && !win.isDestroyed() ? win : null;
}

export async function openBootstrapSettingsWindow(
  owner: BrowserWindow,
  options: {
    preload: string;
    attach: (win: BrowserWindow) => void;
    load: (win: BrowserWindow) => Promise<void>;
    quitting: () => boolean;
  },
): Promise<void> {
  const existing = getBootstrapSettingsWindow(owner);
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }
  const area = screen.getDisplayMatching(owner.getBounds()).workArea;
  const win = new BrowserWindow({
    parent: owner,
    title: 'WeQ · 设置',
    ...WINDOW_LAYOUTS.chat,
    width: Math.min(WINDOW_LAYOUTS.chat.width, area.width),
    height: Math.min(WINDOW_LAYOUTS.chat.height, area.height),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      session: owner.webContents.session,
      preload: options.preload,
      sandbox: false,
      contextIsolation: true,
    },
  });
  windows.set(owner, win);
  win.on('page-title-updated', (event) => event.preventDefault());
  const ownerClosed = () => {
    if (!win.isDestroyed()) win.destroy();
  };
  owner.once('closed', ownerClosed);
  win.once('closed', () => {
    owner.removeListener('closed', ownerClosed);
    windows.delete(owner);
  });
  const contents = win.webContents;
  // 只有设置页已经接管关闭时才拦截原生按钮，加载或崩溃时仍可直接关窗。
  let guardClose = false;
  const resetCloseGuard = () => {
    guardClose = false;
  };
  contents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) resetCloseGuard();
  });
  contents.on('render-process-gone', resetCloseGuard);
  contents.ipc.on('bootstrap-settings:close-ready', (event) => {
    if (event.senderFrame === contents.mainFrame) guardClose = true;
  });
  contents.ipc.on('bootstrap-settings:close', (event) => {
    if (event.senderFrame !== contents.mainFrame) return;
    resetCloseGuard();
    win.close();
  });
  win.on('close', (event) => {
    if (!guardClose || options.quitting()) return;
    event.preventDefault();
    contents.send('bootstrap-settings:request-close');
  });
  win.once('ready-to-show', () => win.show());
  try {
    options.attach(win);
    await options.load(win);
  } catch (error) {
    if (win.isDestroyed()) return;
    win.destroy();
    throw error;
  }
}

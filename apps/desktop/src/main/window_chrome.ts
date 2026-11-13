import { BrowserWindow, ipcMain } from 'electron';
import { nativeWindowChrome } from '../shared/window_chrome';
import type { WindowControlsStyle } from '../shared/window_controls';

export function registerWindowChromeIpc(controls: (win: BrowserWindow) => WindowControlsStyle) {
  ipcMain.on('window:get-chrome', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    event.returnValue = win ? readWindowChrome(win, controls(win)) : null;
  });
}

export function readWindowChrome(win: BrowserWindow, controls: WindowControlsStyle) {
  const [width = 0, height = 0] = win.getContentSize();
  return nativeWindowChrome({
    platform: process.platform,
    controls,
    fullscreen: win.isFullScreen(),
    width,
    height,
  });
}

export function publishWindowChrome(win: BrowserWindow, controls: WindowControlsStyle) {
  if (!win.isDestroyed() && !win.webContents.isDestroyed())
    win.webContents.send('window:chrome-changed', readWindowChrome(win, controls));
}

export function installWindowChrome(win: BrowserWindow, controls: () => WindowControlsStyle) {
  if (process.platform !== 'darwin') return;
  const update = () => publishWindowChrome(win, controls());
  win.on('resize', update);
  win.on('enter-full-screen', update);
  win.on('leave-full-screen', update);
  win.webContents.on('did-finish-load', update);
}

/**
 * Primary-window registry.
 *
 * `index.ts` owns the window lifecycle; service modules (e.g. the attach-hint
 * bridge) need to reach it without importing `index.ts` back (a module cycle).
 * Keeping the reference here breaks that cycle.
 */

import type { BrowserWindow } from 'electron';
import { setDisplayMediaMainWebContents } from './call_display_media';

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
  // 屏幕共享的 `getDisplayMedia` handler 靠它区分「主界面」与「工具窗」：
  // 主界面不该有共享需求，一律拒绝（见 call_display_media.ts）。
  // 窗口销毁后要清掉，否则重建的主窗口会拿到旧 id 而被误判成工具窗。
  setDisplayMediaMainWebContents(win && !win.isDestroyed() ? win.webContents.id : null);
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

import { ipcMain, webContents, type WebContents } from 'electron';

const bridged = new WeakSet<WebContents>();

export function registerEditUndoIpc(): void {
  ipcMain.on('edit:undo-ready', (event) => bridged.add(event.sender));
  ipcMain.on('edit:undo-text', (event) => {
    if (!event.sender.isDestroyed()) event.sender.undo();
  });
}

/** 无桥接的网页或开发者工具仍由 Electron 原生撤销。 */
export function undoFocusedContent(): void {
  const focused = webContents.getFocusedWebContents();
  if (!focused || focused.isDestroyed()) return;
  if (bridged.has(focused)) focused.send('edit:undo');
  else focused.undo();
}

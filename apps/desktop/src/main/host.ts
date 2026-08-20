/**
 * Electron implementation of {@link HostBridge} — native file dialogs and
 * `shell.openPath`. Installed once from `index.ts` before any router runs.
 */

import { app, dialog, shell } from 'electron';
import type { HostBridge, SaveTarget } from '@weq/service';

export const electronHost: HostBridge = {
  canReveal: true,

  async pickDirectory(opts) {
    const result = await dialog.showOpenDialog({
      title: opts?.title,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  },

  async pickFile(opts) {
    const result = await dialog.showOpenDialog({
      title: opts?.title,
      filters: opts?.extensions?.length
        ? [{ name: 'File', extensions: opts.extensions }]
        : undefined,
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  },

  async pickSaveTarget({ defaultName, extension }): Promise<SaveTarget | null> {
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: extension ? [{ name: 'File', extensions: [extension] }] : undefined,
    });
    if (result.canceled || !result.filePath) return null;
    return { path: result.filePath, downloadId: null };
  },

  async revealPath(path) {
    const err = await shell.openPath(path);
    if (err) throw new Error(err);
  },

  async revealInFolder(path) {
    shell.showItemInFolder(path);
  },

  async openExternal(url) {
    await shell.openExternal(url);
  },

  async openHtmlReport(path) {
    const { openReportWindow } = await import('./report_window');
    await openReportWindow(path);
    return null;
  },

  async openBotConsole({ url, key, title }) {
    const { openBotWebUiWindow } = await import('./bot_webui_window');
    await openBotWebUiWindow(url, key, title);
    return null;
  },

  appVersion: () => app.getVersion(),
  isPackaged: () => app.isPackaged,
};

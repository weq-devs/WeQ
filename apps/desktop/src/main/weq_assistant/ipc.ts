/**
 * Electron-only IPC surface for the WeQ 助手 server. Split from `server.ts` so
 * that module stays free of `electron` imports and can be reused by the web app.
 */

import { ipcMain } from 'electron';
import { setWeqTheme } from './theme';

/**
 * Register the renderer→main theme pipe. The renderer's `applyTheme` calls this
 * whenever accent / 深浅 changes (and once on hydrate), so the 每日推文 封面 + 跳转页
 * — rendered in the main process — track WeQ Desktop's theme. Idempotent; safe
 * to call once at startup even before the server is enabled.
 */
export function registerWeqAssistantIpc(): void {
  ipcMain.handle(
    'weqAssistant:set-theme',
    (_event, theme?: { accent?: string; mode?: 'light' | 'dark' }) => {
      setWeqTheme(theme);
      return true;
    },
  );
}

/**
 * Electron-only IPC surface for the WeQ 助手. The renderer's `applyTheme` calls
 * the handler whenever accent / 深浅 changes (and once on hydrate).
 *
 * Theme is **baked into the published docroot files** (the daemon serves static
 * HTML/PNG only), so a theme change re-publishes them — trailing-debounced:
 * hydrate + a quick accent sweep emits several calls in a row, and each render
 * pass (satori → PNG) is too expensive to run per keystroke. The publish step
 * is a no-op when the assistant toggle is off (docroot dir absent → skip).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import { setWeqTheme } from './theme';
import { publishWeqAssistantDocroot } from './publish';
import { requireBootstrap } from '../context/app_context';

const DEBOUNCE_MS = 600;

let republishTimer: NodeJS.Timeout | null = null;

/** Trailing-debounced docroot re-publish (theme changes are baked into files). */
export function scheduleDocrootRepublish(): void {
  if (republishTimer) clearTimeout(republishTimer);
  republishTimer = setTimeout(() => {
    republishTimer = null;
    try {
      const userConfig = requireBootstrap().userConfig;
      // 助手未启用时（docroot 还没被发布过）跳过 —— 开关打开时全量发布。
      const docroot = join(userConfig.cacheDir('weq-assistant'), 'docroot');
      if (!existsSync(docroot)) return;
      void publishWeqAssistantDocroot({ docroot });
    } catch {
      // bootstrap 未就绪（极早期 hydrate）：跳过，下一次主题推送会再试。
    }
  }, DEBOUNCE_MS);
}

/**
 * Register the renderer→main theme pipe. Idempotent; safe to call once at
 * startup even before the assistant is enabled.
 */
export function registerWeqAssistantIpc(): void {
  ipcMain.handle(
    'weqAssistant:set-theme',
    (_event, theme?: { accent?: string; mode?: 'light' | 'dark' }) => {
      setWeqTheme(theme);
      scheduleDocrootRepublish();
      return true;
    },
  );
}

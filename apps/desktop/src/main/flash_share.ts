/**
 * FlashShare theme — QQ 闪传分享页本身支持 prefers-color-scheme 深色。
 *
 * 与 qzone / channel 的 set-theme 同一机制：`nativeTheme.themeSource` 是进程级的，
 * 弹窗打开时同步到 WeQ 当前深浅（resolved），关闭时恢复成偏好 —— 分享页 webview 跟随
 * 应用主题，且不会把空间 / 频道等其他 webview 永久带跑。
 */

import { ipcMain, nativeTheme } from 'electron';

type FlashShareTheme = 'system' | 'light' | 'dark';

function applyFlashShareTheme(theme: FlashShareTheme | undefined): void {
  if (theme === 'system' || theme === 'light' || theme === 'dark') {
    nativeTheme.themeSource = theme;
  }
}

export function registerFlashShareIpc(): void {
  ipcMain.handle('flashShare:set-theme', (_event, theme?: FlashShareTheme) => {
    applyFlashShareTheme(theme);
    return true;
  });
}

import type { BrowserWindowConstructorOptions, BrowserWindow } from 'electron';

/** 只给应用自己的空白合成工作窗放行；内容由父渲染进程挂载，不注入 preload。 */
export function compositionPopupOptions(
  url: string,
  frameName: string,
): BrowserWindowConstructorOptions | null {
  if (url !== 'about:blank' || frameName !== 'weq-compose') return null;
  return {
    title: 'WeQ · 合成聊天记录',
    width: 1000,
    height: 680,
    frame: false,
    minWidth: 680,
    minHeight: 480,
    autoHideMenuBar: true,
    webPreferences: {
      preload: undefined,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  };
}

export function controlCompositionWindow(
  window: Pick<
    BrowserWindow,
    'isDestroyed' | 'minimize' | 'isMaximized' | 'maximize' | 'unmaximize'
  >,
  action: unknown,
): void {
  if (window.isDestroyed()) return;
  if (action === 'minimize') window.minimize();
  else if (action === 'toggle-maximize') {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  }
}

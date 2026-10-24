import type { BrowserWindowConstructorOptions } from 'electron';
import { compositionPopupOptions } from './composition_window';
import { floatingWindowTypeOption } from './linux_window_backend';

/** 仅放行明确登记的本地空白工具窗，不给子窗口增加 preload 或 Node 权限。 */
export function applicationToolPopupOptions(
  url: string,
  frameName: string,
): BrowserWindowConstructorOptions | null {
  if (url === 'about:blank' && frameName === 'weq-call')
    return {
      title: 'WeQ · 语音通话',
      width: 400,
      height: 600,
      minWidth: 340,
      minHeight: 540,
      frame: true,
      autoHideMenuBar: true,
      ...floatingWindowTypeOption(),
      webPreferences: {
        preload: undefined,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    };
  if (url === 'about:blank' && frameName === 'weq-db-repair')
    return {
      title: 'WeQ · 数据库修复',
      width: 1060,
      height: 780,
      minWidth: 640,
      minHeight: 480,
      frame: true,
      autoHideMenuBar: true,
      ...floatingWindowTypeOption(),
      webPreferences: {
        preload: undefined,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    };
  return compositionPopupOptions(url, frameName);
}

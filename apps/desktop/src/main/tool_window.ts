import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { compositionPopupOptions } from './composition_window';
import { floatingWindowTypeOption } from './linux_window_backend';
import { windowDecorationOptions } from './window_controls_events';
import { readGroupResourceWindowName } from '../shared/group_resource_window';
import { MONITOR_WINDOWS } from '../shared/monitor_window';
import { DATABASE_BROWSER_WINDOW } from '../shared/database_window';

type ToolWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isMinimized' | 'restore' | 'show' | 'focus'
> & { once(event: 'closed', listener: () => void): unknown };

/** 网页 focus 无法可靠恢复原生最小化窗口，按所属主窗和工具名在主进程唤出。 */
export function createToolWindowRegistry() {
  const owners = new Map<number, Map<string, ToolWindow>>();
  return {
    register(owner: number, name: string, window: ToolWindow) {
      let windows = owners.get(owner);
      if (!windows) {
        windows = new Map();
        owners.set(owner, windows);
      }
      windows.set(name, window);
      window.once('closed', () => {
        const current = owners.get(owner);
        if (current?.get(name) !== window) return;
        current.delete(name);
        if (!current.size) owners.delete(owner);
      });
    },
    focus(owner: number, name: unknown): boolean {
      if (typeof name !== 'string') return false;
      const window = owners.get(owner)?.get(name);
      if (!window || window.isDestroyed()) return false;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return true;
    },
    clear(owner: number) {
      owners.delete(owner);
    },
  };
}

/** 仅放行明确登记的本地空白工具窗，不给子窗口增加 preload 或 Node 权限。 */
export function applicationToolPopupOptions(
  url: string,
  frameName: string,
): BrowserWindowConstructorOptions | null {
  const monitor =
    url === 'about:blank'
      ? [...Object.values(MONITOR_WINDOWS), DATABASE_BROWSER_WINDOW].find(
          (item) => item.name === frameName,
        )
      : undefined;
  if (monitor)
    return {
      title: monitor.title,
      width: monitor.width,
      height: monitor.height,
      minWidth: monitor.minWidth,
      minHeight: monitor.minHeight,
      frame: true,
      ...windowDecorationOptions(),
      autoHideMenuBar: true,
      ...floatingWindowTypeOption(),
      webPreferences: {
        preload: undefined,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    };
  const resource = url === 'about:blank' ? readGroupResourceWindowName(frameName) : null;
  if (resource)
    return {
      title: `WeQ · 群${resource.kind === 'albums' ? '相册' : '文件'}`,
      width: 1060,
      height: 780,
      minWidth: 640,
      minHeight: 480,
      frame: true,
      ...windowDecorationOptions(),
      autoHideMenuBar: true,
      webPreferences: {
        preload: undefined,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    };
  // 群通话是横屏布局：主舞台 + 缩略条 + 成员栏，需要比私聊通话宽得多。
  if (url === 'about:blank' && frameName === 'weq-group-call')
    return {
      title: 'WeQ · 群通话',
      width: 1180,
      height: 720,
      minWidth: 760,
      minHeight: 520,
      frame: true,
      ...windowDecorationOptions(),
      autoHideMenuBar: true,
      ...floatingWindowTypeOption(),
      webPreferences: {
        preload: undefined,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    };
  if (url === 'about:blank' && frameName === 'weq-call')
    return {
      title: 'WeQ · 语音通话',
      width: 400,
      height: 620,
      minWidth: 340,
      minHeight: 540,
      frame: true,
      ...windowDecorationOptions(),
      autoHideMenuBar: true,
      ...floatingWindowTypeOption(),
      webPreferences: {
        preload: undefined,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    };
  if (url === 'about:blank' && (frameName === 'weq-db-repair' || frameName === 'weq-capture'))
    return {
      title: frameName === 'weq-capture' ? 'WeQ · QQNT 抓包' : 'WeQ · 数据库修复',
      width: 1060,
      height: 780,
      minWidth: 640,
      minHeight: 480,
      frame: true,
      ...windowDecorationOptions(),
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

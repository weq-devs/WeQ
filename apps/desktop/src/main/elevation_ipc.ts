/**
 * 桌面端「请求管理员密码」的 IPC 实现 —— 注册进 electron-free 的
 * `sudo_prompt` seam。web server 不导入本模块（`check-electron-free` 守卫）。
 *
 * 机制：主进程发 `elev:request-password`，渲染层弹密码框（复用 DialogHost
 * 的密码 UI），回传 `elev:respond-password`。请求带 token，响应校验 token；
 * 并发请求合并到同一个对话框、共享同一个答案；超时 / 窗口关闭兜底返回
 * null（取消）。密码只在本进程内短暂存活，不落盘、不进日志。
 */

import { ipcMain } from 'electron';
import { getLogger } from '@weq/service';
import { getMainWindow } from './main_window';
import { setSudoPasswordPrompt } from './sudo_prompt';

const logger = getLogger().child({ scope: 'elevation' });

const REQUEST_CHANNEL = 'elev:request-password';
const RESPOND_CHANNEL = 'elev:respond-password';

/** 对话框可能要等用户去翻密码管理器——给足时间。 */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

let pendingResolve: ((password: string | null) => void) | null = null;
let pending: Promise<string | null> | null = null;
let pendingToken = 0;
let pendingTimer: NodeJS.Timeout | null = null;

/** 注册 IPC 监听（main/index.ts 启动时调用一次）。 */
export function registerElevationIpc(): void {
  ipcMain.on(RESPOND_CHANNEL, (_event, raw: unknown) => {
    const payload = (raw ?? {}) as { token?: unknown; password?: unknown };
    if (typeof payload.token !== 'number' || payload.token !== pendingToken) return;
    const password =
      typeof payload.password === 'string' && payload.password.length > 0 ? payload.password : null;
    logger.info('elevation password answered', {
      event: 'elevation-password-answered',
      ok: password !== null,
    });
    pendingResolve?.(password);
  });
  setSudoPasswordPrompt((title, message) => requestSudoPasswordImpl(title, message));
}

/**
 * 请求渲染层弹密码框并等待输入。返回密码；取消 / 超时 / 无主窗口返回
 * null。并发请求合并：多个调用方共享同一个对话框和答案。
 */
function requestSudoPasswordImpl(title: string, message: string): Promise<string | null> {
  if (pending) return pending;

  const token = ++pendingToken;
  const win = getMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    // 无头（web server / 窗口已关）——没有密码框可弹，调用方按取消处理。
    return Promise.resolve(null);
  }

  pending = new Promise<string | null>((resolve) => {
    const finish = (password: string | null): void => {
      if (pendingToken !== token) return; // 旧请求的超时/关闭，忽略
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingResolve = null;
      pending = null;
      resolve(password);
    };
    pendingResolve = finish;
    pendingTimer = setTimeout(() => {
      logger.warn('elevation password request timed out', {
        event: 'elevation-password-timeout',
      });
      finish(null);
    }, PROMPT_TIMEOUT_MS);
    win.once('closed', () => {
      logger.info('main window closed while elevation password pending', {
        event: 'elevation-password-window-closed',
      });
      finish(null);
    });
    win.webContents.send(REQUEST_CHANNEL, { token, title, message });
    logger.info('asked renderer for elevation password', {
      event: 'elevation-password-requested',
    });
  });
  return pending;
}

/**
 * 退出确认的「主进程 → 渲染层」桥。
 *
 * 取代原来的原生 `dialog.showMessageBox`：那个框不跟主题、没有「不再询问」、
 * 每次退出都弹。现在发给渲染层的 `QuitConfirmDialog`，跟随深浅模式与主题色。
 *
 * 协议与 `attach_hint_ipc.ts` 同构（`SharedPrompt` 合并并发请求 + token 防串 +
 * sender 校验 + 超时兜底）：
 *
 *   主 → 渲染  `quit:confirm`  { token, services: string[] }
 *   渲染 → 主  `quit:respond`  { token, choice: 'quit' | 'window' | 'cancel', remember }
 *
 * 窗口不可用（还没建 / 已销毁）时**不拦退出**：直接当作「确认退出」，否则用户会
 * 卡在一个永远等不到回应的 `before-quit` 上。
 */

import { ipcMain } from 'electron';
import { getLogger, SharedPrompt } from '@weq/service';
import { getMainWindow } from './main_window';

const logger = getLogger().child({ scope: 'quit-confirm' });

const CONFIRM_CHANNEL = 'quit:confirm';
const RESPOND_CHANNEL = 'quit:respond';

/** 用户可能去倒杯水；给足时间，但别无限挂着。 */
const PROMPT_TIMEOUT_MS = 60 * 1000;

/**
 * 退出确认的三种结果。
 *
 * 与 `app_quit_confirmation.ts` 的 `QuitChoice` 保持同一套词汇：`window` 表示
 * 「只关窗口、进程继续」，不是 `tray` —— 后者只是用户在设置里看到的说法。
 */
export type QuitConfirmChoice = 'quit' | 'window' | 'cancel';

export interface QuitConfirmAnswer {
  choice: QuitConfirmChoice;
  /** 勾了「不再询问」。取消不记。 */
  remember: boolean;
}

const CANCELLED: QuitConfirmAnswer = { choice: 'cancel', remember: false };

let pendingResolve: ((answer: QuitConfirmAnswer) => void) | null = null;
let pendingToken = 0;
const prompt = new SharedPrompt<QuitConfirmAnswer>(CANCELLED);

/** 注册渲染层的应答监听。重复调用只保留一个监听器。 */
let listener: ((event: { sender: unknown }, raw: unknown) => void) | null = null;
export function registerQuitConfirmIpc(): void {
  if (listener) ipcMain.removeListener(RESPOND_CHANNEL, listener);
  listener = (event, raw: unknown) => {
    if (event.sender !== getMainWindow()?.webContents || !pendingResolve) return;
    const payload = (raw ?? {}) as {
      token?: unknown;
      choice?: unknown;
      remember?: unknown;
    };
    if (payload.token !== pendingToken) return;
    const valid =
      payload.choice === 'quit' || payload.choice === 'window' || payload.choice === 'cancel';
    const choice: QuitConfirmChoice = valid ? (payload.choice as QuitConfirmChoice) : 'cancel';
    logger.info('quit confirmation answered', { event: 'quit-confirm-answered', choice });
    // 非法 choice 连同 remember 一起作废，别让坏报文写进偏好。
    pendingResolve?.({ choice, remember: valid && payload.remember === true });
  };
  ipcMain.on(RESPOND_CHANNEL, listener);
}

/** 让渲染层弹确认框，等用户选择。窗口不可用时直接放行退出。 */
export function promptQuitConfirm(services: string[]): Promise<QuitConfirmAnswer> {
  return prompt.request((finish) => {
    const token = ++pendingToken;
    const win = getMainWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      finish({ choice: 'quit', remember: false });
      return () => {};
    }
    // 窗口可能在托盘里 —— 先唤出来，否则用户看不到这个框。
    if (!win.isVisible()) win.show();
    win.focus();

    pendingResolve = finish;
    const cancel = (): void => finish(CANCELLED);
    const timer = setTimeout(cancel, PROMPT_TIMEOUT_MS);
    win.once('closed', cancel);
    win.webContents.send(CONFIRM_CHANNEL, { token, services });
    return () => {
      clearTimeout(timer);
      win.removeListener('closed', cancel);
      if (pendingToken === token) pendingResolve = null;
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('quit:cancel-confirm', { token });
      }
    };
  });
}

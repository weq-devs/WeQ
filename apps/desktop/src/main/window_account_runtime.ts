import { ipcMain, type Session, type WebContents } from 'electron';
import {
  type AccountRuntime,
  currentAccountRuntime,
  primaryAccountRuntime,
} from './context/account_runtime';

const runtimes = new WeakMap<Session, AccountRuntime>();
const sessions = new WeakMap<AccountRuntime, Session>();

export function bindAccountSession(session: Session, runtime: AccountRuntime): () => void {
  runtimes.set(session, runtime);
  sessions.set(runtime, session);
  return () => {
    runtimes.delete(session);
    sessions.delete(runtime);
  };
}

export function accountRuntimeFor(sender: WebContents): AccountRuntime {
  return runtimes.get(sender.session) ?? primaryAccountRuntime;
}

export function accountSession(): Session | undefined {
  return sessions.get(currentAccountRuntime());
}

type IpcListener = Parameters<typeof ipcMain.on>[1];

/** 原有 preload IPC 通道按发送窗口的浏览器会话进入账号作用域。 */
export const accountIpc = {
  handle(channel: string, handler: Parameters<typeof ipcMain.handle>[1]): void {
    ipcMain.handle(channel, (event, ...args) =>
      accountRuntimeFor(event.sender).run(() => handler(event, ...args)),
    );
  },
  on(channel: string, listener: IpcListener): void {
    ipcMain.on(channel, (event, ...args) =>
      accountRuntimeFor(event.sender).run(() => listener(event, ...args)),
    );
  },
};

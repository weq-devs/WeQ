/**
 * 渲染层：响应主进程 `elev:request-password` 的密码框（Linux 自绘提权框）。
 *
 * 主进程在需要管理员密码（sudo -S 提权：后台注入、登录前 stub 迁移等）时
 * 发 `elev:request-password`，本组件复用全局 DialogHost 的密码 UI
 * （useDialog.promptPassword），用户输入后经 `elev:respond-password`
 * 回传；取消则回传 null。密码只存在于主进程这次 sudo 调用里。
 */

import { useEffect } from 'react';
import { useDialog } from './Dialog';

function ipc():
  | {
      on(ch: string, cb: (...a: unknown[]) => void): (() => void) | undefined;
      send(ch: string, ...a: unknown[]): void;
    }
  | undefined {
  return (window as unknown as { electron?: { ipcRenderer?: ReturnType<typeof ipc> } }).electron
    ?.ipcRenderer;
}

export function ElevationPasswordDialog(): null {
  const promptPassword = useDialog((s) => s.promptPassword);

  useEffect(() => {
    // `ipcRenderer.on` 的回调签名是 `(event, ...args)`——payload 是第二个
    // 参数（第一个是 IpcRendererEvent）。与 CloseConfirmDialog 一致。
    const off = ipc()?.on('elev:request-password', (_event, raw: unknown) => {
      const payload = (raw ?? {}) as { token?: number; title?: string; message?: string };
      if (typeof payload.token !== 'number') return;
      void (async () => {
        const password = await promptPassword(
          payload.title ?? '需要管理员授权',
          payload.message ?? '请输入管理员密码以继续。',
          { placeholder: '管理员密码' },
        );
        ipc()?.send('elev:respond-password', {
          token: payload.token,
          password,
        });
      })();
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [promptPassword]);

  return null;
}

/**
 * Asks the main process to resize the window for the current view
 * (see `window:set-layout` in src/main/index.ts).
 *
 * `window.electron` is the @electron-toolkit/preload bridge; its type lives in
 * the preload package (outside this tsconfig program), so we narrow locally.
 */

export type WindowLayout = 'home' | 'chat' | 'settings';

type IpcBridge = {
  process?: { platform?: string };
  ipcRenderer?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> };
};
let latestRequest = 0;

export function setWindowLayout(layout: WindowLayout): void {
  const request = ++latestRequest;
  const bridge = (window as unknown as { electron?: IpcBridge }).electron;
  const ipc = bridge?.ipcRenderer;
  void ipc
    ?.invoke?.('window:set-layout', layout)
    .then((applied) => {
      // 热更新期间的旧主进程会忽略 settings；Linux 的 chat 可能重建登录窗口。
      if (
        request === latestRequest &&
        layout === 'settings' &&
        applied !== true &&
        bridge?.process?.platform !== 'linux'
      )
        return ipc.invoke?.('window:set-layout', 'chat');
    })
    .catch(() => undefined);
}

/**
 * Asks the main process to resize the window for the current view
 * (see `window:set-layout` in src/main/index.ts).
 *
 * `window.electron` is the @electron-toolkit/preload bridge; its type lives in
 * the preload package (outside this tsconfig program), so we narrow locally.
 */

export type WindowLayout = 'home' | 'chat';

type IpcBridge = {
  ipcRenderer?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> };
};

export function setWindowLayout(layout: WindowLayout): void {
  const bridge = (window as unknown as { electron?: IpcBridge }).electron;
  void bridge?.ipcRenderer?.invoke?.('window:set-layout', layout);
}

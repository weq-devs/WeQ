/**
 * Preload script.
 *
 * `exposeElectronTRPC()` from `electron-trpc/main` (yes, "main" — the
 * preload path is exported there too in v0.7) sets up the IPC bridge
 * needed by `ipcLink()` on the renderer side. Without this call,
 * `ipcLink()` would log "process.electronTRPC is not defined".
 *
 * Everything else stays minimal — auth/contextBridge surface area is
 * intentionally small.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';
import { createRequire } from 'node:module';

// Same CJS workaround as src/main/index.ts — electron-trpc 0.7's ESM
// build statically imports `ipcMain` from 'electron', which is not
// exposed inside the preload context. CJS resolution tolerates this.
const requireFromHere = createRequire(import.meta.url);
const { exposeElectronTRPC } = requireFromHere(
  'electron-trpc/main',
) as typeof import('electron-trpc/main');

exposeElectronTRPC();

const weqBridge = {
  openLogDir: (): Promise<boolean> => ipcRenderer.invoke('logs:open-dir') as Promise<boolean>,
  channel: {
    /** Open (or focus) the built-in QQ 频道 browser for the current account.
     *  Pass WeQ's theme preference so the window follows 深/浅 mode. */
    open: (theme?: 'system' | 'light' | 'dark'): Promise<boolean> =>
      ipcRenderer.invoke('channel:open', theme) as Promise<boolean>,
    /** Push WeQ's theme preference to the channel window (live 深/浅 follow). */
    setTheme: (theme: 'system' | 'light' | 'dark'): Promise<boolean> =>
      ipcRenderer.invoke('channel:set-theme', theme) as Promise<boolean>,
    /** Read the current account's pd.qq.com cookies (for future 频道导出/分析). */
    getCookies: () =>
      ipcRenderer.invoke('channel:get-cookies') as Promise<
        { name: string; value: string; domain?: string; path?: string }[]
      >,
  },
  qzone: {
    /** Open (or focus) the built-in QQ 空间 browser for the current account.
     *  Pass WeQ's theme preference so the window follows 深/浅 mode. */
    open: (theme?: 'system' | 'light' | 'dark'): Promise<boolean> =>
      ipcRenderer.invoke('qzone:open', theme) as Promise<boolean>,
    /** Push WeQ's theme preference to the Qzone window (live 深/浅 follow). */
    setTheme: (theme: 'system' | 'light' | 'dark'): Promise<boolean> =>
      ipcRenderer.invoke('qzone:set-theme', theme) as Promise<boolean>,
    /** Read the current account's qzone.qq.com cookies (for future 空间导出/分析). */
    getCookies: () =>
      ipcRenderer.invoke('qzone:get-cookies') as Promise<
        { name: string; value: string; domain?: string; path?: string }[]
      >,
  },
  weqAssistant: {
    /**
     * Push WeQ's accent + 深/浅 to the main process so the 每日推文 ARK 封面 / 跳转页
     * (rendered in the main process, no localStorage access) follow the theme.
     * `accent` is a free-form hex; empty falls back to the WeQ default blue.
     */
    setTheme: (theme: { accent: string; mode: 'light' | 'dark' }): Promise<boolean> =>
      ipcRenderer.invoke('weqAssistant:set-theme', theme) as Promise<boolean>,
  },
  systemAuth: {
    getStatus: () =>
      ipcRenderer.invoke('systemAuth:getStatus') as Promise<{
        platform: string;
        available: boolean;
        method: 'windows-hello' | 'touch-id' | 'none';
        displayName: string;
        error?: string;
      }>,
    verify: (reason?: string) =>
      ipcRenderer.invoke('systemAuth:verify', reason) as Promise<{
        success: boolean;
        method: 'windows-hello' | 'touch-id' | 'none';
        error?: string;
      }>,
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('weq', weqBridge);
  } catch (err) {
    console.error('contextBridge expose failed:', err);
  }
} else {
  // @ts-expect-error legacy non-isolated mode
  window.electron = electronAPI;
  // @ts-expect-error legacy non-isolated mode
  window.weq = weqBridge;
}

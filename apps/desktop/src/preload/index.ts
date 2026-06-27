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

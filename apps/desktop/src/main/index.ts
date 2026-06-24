import { app, BrowserWindow, ipcMain, nativeImage, protocol, shell } from 'electron';
import fs from 'node:fs';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initAppContext } from './context/app_context';
import { appRouter } from './ipc/router';
import { resolveResource } from './resource';
import {
  registerResourceProtocol,
  RESOURCE_PRIVILEGED_SCHEME,
} from './resource_protocol';
import {
  registerAvatarProtocol,
  AVATAR_PRIVILEGED_SCHEME,
} from './avatar_protocol';
import {
  registerMediaProtocol,
  MEDIA_PRIVILEGED_SCHEME,
} from './media_protocol';
import { getAppContext } from './context/app_context';
import { checkForUpdate } from './update/updater';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Privileged-scheme registration must happen before app `ready`, and Electron
// honors only ONE `registerSchemesAsPrivileged` call — register every custom
// scheme together here.
protocol.registerSchemesAsPrivileged([
  RESOURCE_PRIVILEGED_SCHEME,
  AVATAR_PRIVILEGED_SCHEME,
  MEDIA_PRIVILEGED_SCHEME,
]);

const requireFromHere = createRequire(import.meta.url);
const { createIPCHandler } = requireFromHere('electron-trpc/main') as typeof import('electron-trpc/main');

/**
 * Per-view window sizes. The home/bootstrap screen is compact; the chat view
 * gets a bit more room. Switching views resizes the window (see the
 * `window:set-layout` IPC), keeping the top-left corner fixed.
 */
const WINDOW_LAYOUTS = {
  home: { width: 1120, height: 580 },
  chat: { width: 1180, height: 760 },
} as const;

function registerWindowLayoutIpc(): void {
  ipcMain.handle('window:set-layout', (event, layout: keyof typeof WINDOW_LAYOUTS) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const size = WINDOW_LAYOUTS[layout] ?? WINDOW_LAYOUTS.home;
    // Don't fight a user who maximized/fullscreened the window.
    if (!win || win.isMaximized() || win.isFullScreen()) return;
    const [w, h] = win.getSize();
    if (w === size.width && h === size.height) return;
    win.setSize(size.width, size.height, true);
  });

  ipcMain.on('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.on('window-close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

/**
 * Reveal a chat media file (video/file) in the OS file manager. The renderer
 * passes the lookup inputs (sendTime ms, file name, type); we resolve the real
 * path via the account services and `showItemInFolder`. Returns whether a file
 * was found and revealed.
 */
function registerMediaIpc(): void {
  ipcMain.handle(
    'media:reveal',
    async (_event, input: { t: number; name: string; type: 'video' | 'file' | 'pic' | 'ptt' }) => {
      const services = getAppContext().services;
      if (!services) return false;
      const { source } = await services.fileSearch.findFile(input.t, input.name, input.type);
      if (!source) return false;
      shell.showItemInFolder(source);
      return true;
    },
  );

  ipcMain.handle('file:reveal', async (_event, msgId: string) => {
    const services = getAppContext().services;
    if (!services) return { success: false, error: 'Session closed' };

    try {
      const file = await services.fileAssistant.getFileInfoByMsgId(BigInt(msgId));
      if (!file) return { success: false, error: '未找到该文件' };

      // Path in NT often starts with ::NTOSFull::
      let realPath = file.localPath;
      if (realPath.startsWith('::NTOSFull::')) {
        realPath = realPath.slice(12);
      }

      if (!realPath || !fs.existsSync(realPath)) {
        return { success: false, error: '未找到该文件' };
      }

      shell.showItemInFolder(realPath);
      return { success: true };
    } catch (e) {
      return { success: false, error: '查询失败' };
    }
  });
}

function resolveWindowIcon(): Electron.NativeImage | undefined {
  const path = resolveResource('brand', 'logo.png');
  if (!path) return undefined;
  const img = nativeImage.createFromPath(path);
  return img.isEmpty() ? undefined : img;
}

function createWindow(): BrowserWindow {
  const icon = resolveWindowIcon();
  const win = new BrowserWindow({
    width: 1120,
    height: 580,
    minWidth: 940,
    minHeight: 520,
    show: false,
    title: 'WeQ Desktop',
    autoHideMenuBar: true,
    backgroundColor: '#f0f0f0',
    titleBarStyle: 'hidden',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  const reveal = () => {
    if (win.isDestroyed() || win.isVisible()) return;
    win.show();
    win.focus();
  };

  win.on('ready-to-show', reveal);
  // Fallback: in some environments `ready-to-show` can be delayed or missed
  // (e.g. compositor/driver quirks). Guarantee visibility once content loads.
  win.webContents.on('did-finish-load', reveal);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('app.weq.desktop');

  // Order matters: AppContext (loads native + platform) before IPC handler.
  initAppContext();

  registerResourceProtocol();
  registerAvatarProtocol();
  registerMediaProtocol();
  registerWindowLayoutIpc();
  registerMediaIpc();

  app.on('browser-window-created', (_, win) => {
    optimizer.watchWindowShortcuts(win);
  });

  const win = createWindow();
  createIPCHandler({ router: appRouter, windows: [win] });

  // Silent background update check (packaged builds only). Result is cached and
  // pushed to the renderer via the `update.onEvent` subscription → settings red
  // dot. Deferred so it never competes with first paint; failures are ignored.
  if (app.isPackaged) {
    setTimeout(() => void checkForUpdate(true).catch(() => {}), 3000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow();
      createIPCHandler({ router: appRouter, windows: [w] });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

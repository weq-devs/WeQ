import { app, BrowserWindow, nativeImage, shell } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initAppContext } from './context/app_context';
import { appRouter } from './ipc/router';
import { resolveResource } from './resource';
import {
  registerResourceProtocol,
  registerResourceScheme,
} from './resource_protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Privileged-scheme registration must happen before app `ready`.
registerResourceScheme();

const requireFromHere = createRequire(import.meta.url);
const { createIPCHandler } = requireFromHere('electron-trpc/main') as typeof import('electron-trpc/main');

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
    titleBarOverlay: {
      symbolColor: '#142235',
      height: 32,
    },
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

  app.on('browser-window-created', (_, win) => {
    optimizer.watchWindowShortcuts(win);
  });

  const win = createWindow();
  createIPCHandler({ router: appRouter, windows: [win] });

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

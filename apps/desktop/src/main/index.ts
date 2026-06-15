import { app, BrowserWindow, nativeImage, shell } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { initAppContext } from './context/app_context';
import { appRouter } from './ipc/router';

const __dirname = dirname(fileURLToPath(import.meta.url));

const requireFromHere = createRequire(import.meta.url);
const { createIPCHandler } = requireFromHere('electron-trpc/main') as typeof import('electron-trpc/main');

/**
 * Window icon, resolved through Electron's own `nativeImage` toolchain from
 * the shared `resources/brand/logo.png`.
 *
 * Dev: walk up from this bundled file to the repo-root `resources/`.
 * Packaged: electron-builder copies `resources/` to
 * `process.resourcesPath/resources/` (see electron-builder.yml extraResources).
 */
function resolveResource(...segments: string[]): string | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'resources', ...segments), // packaged
    join(__dirname, '../../../../resources', ...segments), // dev (out/main → repo root)
    join(process.cwd(), 'resources', ...segments),
  ];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  return null;
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

  win.on('ready-to-show', () => win.show());

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

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
import { stopMcpServer } from './mcp/server';
import { getLogDir, getLogger, logErrorContext, type MediaElement } from '@weq/service';

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

const logger = getLogger().child({ scope: 'desktop-main' });

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
      logger.info('revealing media file in system explorer', {
        event: 'media-reveal',
        name: input.name,
        mediaType: input.type,
        source,
      });
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

  // OIDB completion for a chat file that isn't on disk. Resolves the download
  // URL (group vs c2c by the message's own kind), streams it into the media
  // cache, then reveals it in the OS file manager. Needs an online QQ.
  ipcMain.handle(
    'file:download',
    async (
      _event,
      input: { msgId: string; name: string; token: string; conv: string },
    ): Promise<{ success: boolean; error?: string; path?: string }> => {
      const ctx = getAppContext();
      const services = ctx.services;
      const boot = ctx.bootstrap;
      if (!services || !boot) return { success: false, error: '?????' };
      const { msgId, name, token, conv } = input;
      console.log('[file:download] request', { msgId, name, token, conv });
      logger.info('requested file download', {
        event: 'file-download-start',
        msgId,
        name,
        token,
        conv,
      });
      if (!msgId) return { success: false, error: '???? ID' };

      let raw: Awaited<ReturnType<typeof services.msgs.getRawElements>>;
      try {
        raw = await services.msgs.getRawElements(BigInt(msgId));
      } catch (e) {
        console.error('[file:download] getRawElements failed:', e);
        return { success: false, error: '??????' };
      }
      if (!raw) return { success: false, error: '??????' };
      const matches = raw.elements.filter((e) => e.kind === 'file');
      console.log('[file:download] kind=%s, file elements=%d', raw.kind, matches.length);
      const el =
        (token ? matches.find((e) => (e as { fileToken?: string }).fileToken === token) : undefined) ??
        matches[0];
      if (!el) return { success: false, error: '??????????' };
      const elToken = (el as { fileToken?: string }).fileToken ?? '';
      console.log('[file:download] element fileToken=%s', elToken);

      const fileName = name || (el as { fileName?: string }).fileName || elToken || 'download';
      const dest = join(boot.userConfig.cacheDir('media'), 'file', fileName);
      if (fs.existsSync(dest)) {
        logger.info('file download cache hit', {
          event: 'file-download-cache-hit',
          msgId,
          path: dest,
        });
        shell.showItemInFolder(dest);
        return { success: true, path: dest };
      }

      let url: string;
      try {
        url = await services.mediaUrl.resolveFileUrl(
          raw.kind,
          Number(conv) || 0,
          el as unknown as MediaElement,
          fileName,
        );
      } catch (e) {
        console.error('[file:download] OIDB resolve failed:', e);
        return { success: false, error: 'OIDB ?????' + (e instanceof Error ? e.message : String(e)) };
      }
      console.log('[file:download] resolved url:', url ? url.slice(0, 120) + '?' : '(empty)');
      if (!url) return { success: false, error: 'OIDB ??????QQ ??????' };

      const { downloadUrlToFile } = await import('@weq/service');
      const outcome = await downloadUrlToFile(url, dest);
      if (!outcome.ok) {
        console.error('[file:download] download failed:', outcome.reason);
        logger.warn('file download failed', {
          event: 'file-download-failed',
          msgId,
          name: fileName,
          reason: outcome.reason,
        });
        return { success: false, error: '?????' + outcome.reason };
      }
      console.log('[file:download] saved to', dest);
      logger.info('file downloaded successfully', {
        event: 'file-download-success',
        msgId,
        name: fileName,
        path: dest,
      });
      shell.showItemInFolder(dest);
      return { success: true, path: dest };
    },
  );
}

function registerLogIpc(): void {
  ipcMain.handle('logs:open-dir', async () => {
    const dir = getLogDir();
    if (!dir) {
      logger.warn('log directory requested before logger init', { event: 'open-log-dir-unavailable' });
      return false;
    }
    logger.info('opening log directory', { event: 'open-log-dir', dir });
    await shell.openPath(dir);
    return true;
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
  logger.info('electron app ready', { event: 'app-ready' });

  registerResourceProtocol();
  registerAvatarProtocol();
  registerMediaProtocol();
  registerWindowLayoutIpc();
  registerMediaIpc();
  registerLogIpc();

  app.on('browser-window-created', (_, win) => {
    optimizer.watchWindowShortcuts(win);
  });

  const win = createWindow();
  logger.info('main window created', { event: 'create-window' });
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

// Best-effort: stop the account-bound MCP server on quit even if the account
// was never explicitly closed (clearAccount also stops it).
app.on('will-quit', () => {
  void stopMcpServer();
});

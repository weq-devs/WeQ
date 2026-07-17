import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, protocol, shell, Tray } from 'electron';
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
import { stopWeqServer, registerWeqAssistantIpc } from './weq_assistant/server';
import { disposeExternalMcp } from './mcp/external';
import { registerChannelIpc } from './channel';
import { registerQzoneIpc } from './qzone';
import {
  getLogDir,
  getLogger,
  logErrorContext,
  type MediaElement,
  type WindowCloseBehavior,
} from '@weq/service';
import { systemAuthService } from './system_auth';

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

/** The primary app window. Tracked so the tray / single-instance / close flows
 *  can reach it without threading it through every call. */
let mainWindow: BrowserWindow | null = null;
/** System-tray icon; null until built (or if creation failed). */
let tray: Tray | null = null;
/** Set true right before a *real* quit so the `close` handler stops intercepting
 *  and lets the window actually close (托盘退出 / 确认框「完全退出」/ before-quit). */
let isQuitting = false;

/** Bring the main window back to the foreground (from tray / second instance). */
function revealWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Resolve the current 关闭行为 from persisted settings. Falls back to `'quit'`
 * when bootstrap is unavailable (native-load failure → only an error window is
 * showing; hiding it to tray would be pointless).
 */
function resolveCloseBehavior(): WindowCloseBehavior {
  try {
    const boot = getAppContext().bootstrap;
    if (!boot) return 'quit';
    return boot.userConfig.getSettings().windowCloseBehavior ?? 'ask';
  } catch {
    return 'quit';
  }
}

/**
 * Build the system tray once. The icon is the brand logo, downscaled to a
 * tray-appropriate size (16px on Windows; 18px template image on macOS so it
 * tracks the menu-bar's light/dark). Menu: 显示主窗口 / 退出 WeQ. Left-click and
 * double-click both re-reveal the window.
 */
function buildTray(win: BrowserWindow): void {
  if (tray) return;
  const iconPath = resolveResource('brand', 'logo.png');
  let image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (!image.isEmpty()) {
    image = image.resize(
      process.platform === 'darwin' ? { width: 18, height: 18 } : { width: 16, height: 16 },
    );
    if (process.platform === 'darwin') image.setTemplateImage(true);
  }
  try {
    tray = new Tray(image);
    tray.setToolTip('WeQ');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => revealWindow(win) },
        { type: 'separator' },
        {
          label: '退出 WeQ',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on('click', () => revealWindow(win));
    tray.on('double-click', () => revealWindow(win));
    logger.info('system tray created', { event: 'tray-create' });
  } catch (e) {
    logger.warn('failed to create system tray', {
      event: 'tray-create-failed',
      error: String(e),
    });
  }
}

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

  // Reply from the renderer's 关闭确认框 (only sent when behavior === 'ask').
  //   'tray' → hide to tray; 'quit' → real quit; 'cancel' → do nothing.
  ipcMain.on('window:respond-close', (_event, action: 'tray' | 'quit' | 'cancel') => {
    if (action === 'tray') {
      mainWindow?.hide();
    } else if (action === 'quit') {
      isQuitting = true;
      app.quit();
    }
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

function registerSystemAuthIpc(): void {
  ipcMain.handle('systemAuth:getStatus', async () => {
    return systemAuthService.resolveStatus();
  });

  ipcMain.handle('systemAuth:verify', async (event, reason?: string) => {
    const targetWin = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    return systemAuthService.verify(reason, targetWin);
  });
}

/**
 * 截图：抓取发起窗口的客户区（不含桌面 / 标题栏外区域）写入系统剪贴板。
 * 走 webContents.capturePage()——隐私遮罩是 DOM 上的 filter，会如实截到糊后的
 * 效果，故截图天然与隐私模式联动。截完即可粘贴到聊天 / 文档，暂不落盘。
 */
function registerCaptureIpc(): void {
  ipcMain.handle('capture:window', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, error: '找不到目标窗口' };
    try {
      const image = await win.webContents.capturePage();
      if (image.isEmpty()) return { ok: false, error: '截图为空' };
      clipboard.writeImage(image);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
  // On tiling Wayland WMs (Hyprland/sway) new toplevels tile by default. Ask
  // the WM to float us by advertising a non-'normal' window type — 'toolbar'
  // is the least invasive one that Hyprland/sway treat as floating (unlike
  // 'splash', it keeps the taskbar entry). Opt-out with WEQ_WINDOW_TYPE=normal
  // (or override to another value) so this can be disabled per-environment.
  const windowType = process.env.WEQ_WINDOW_TYPE ?? (process.platform === 'linux' ? 'toolbar' : undefined);
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
    ...(windowType && windowType !== 'normal' ? { type: windowType } : {}),
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

  // Intercept the close button so it doesn't hard-quit. Behavior is
  // user-configurable (设置 → 全局设置 → 关闭按钮):
  //   'quit' → let it close (window-all-closed then quits);
  //   'tray' → hide to the system tray, keep the process alive;
  //   'ask'  → ask the renderer to show the 关闭确认框 (default, first time).
  win.on('close', (e) => {
    if (isQuitting || win !== mainWindow) return;
    const behavior = resolveCloseBehavior();
    if (behavior === 'quit') {
      isQuitting = true;
      return;
    }
    e.preventDefault();
    if (behavior === 'tray' && tray) {
      win.hide();
      return;
    }
    // 'ask' — or 'tray' but the tray failed to build → fall back to asking.
    win.webContents.send('window:confirm-close', { canMinimizeToTray: Boolean(tray) });
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  mainWindow = win;
  return win;
}

// Single-instance guard: with the app now living in the tray, a second launch
// should just re-reveal the existing window rather than spawn another
// background process. The non-primary instance quits immediately.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) revealWindow(mainWindow);
  });
}

void app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
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
  registerSystemAuthIpc();
  registerCaptureIpc();
  registerChannelIpc();
  registerQzoneIpc();
  registerWeqAssistantIpc();

  app.on('browser-window-created', (_, win) => {
    optimizer.watchWindowShortcuts(win);
  });

  const win = createWindow();
  logger.info('main window created', { event: 'create-window' });
  createIPCHandler({ router: appRouter, windows: [win] });
  buildTray(win);

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
  // With the tray keeping the process alive, closing the window normally hides
  // it (never reaching here). We only get here on a real quit path — which
  // already sets `isQuitting` — so honour it. macOS keeps the app resident.
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

// A real quit is underway (tray「退出」/ 确认框「完全退出」/ Cmd+Q / OS shutdown):
// flip the flag so the `close` handler stops intercepting, and drop the tray.
app.on('before-quit', () => {
  isQuitting = true;
  if (tray) {
    try {
      tray.destroy();
    } catch {
      /* ignore */
    }
    tray = null;
  }
});

// Best-effort: stop the account-bound MCP server on quit even if the account
// was never explicitly closed (clearAccount also stops it).
app.on('will-quit', () => {
  void stopMcpServer();
  void stopWeqServer();
  void disposeExternalMcp();
});

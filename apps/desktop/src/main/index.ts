import { compositionPopupOptions, controlCompositionWindow } from './composition_window';
import { floatingWindowTypeOption } from './linux_window_backend';
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  shell,
  Tray,
  type IpcMainEvent,
} from 'electron';
import fs from 'node:fs';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  initAppContext,
  setGroupKeywordNotifier,
  setIntentSenseLocalEngine,
  setRecallNotifier,
  setMailNotifier,
} from './context/app_context';
import { getIntentSenseLocalEngine } from './intent_sense/bridge';
import { probeQqProtocolHandler } from './context/qq_protocol';
import { appRouter } from './ipc/router';
import { guardTrpcReply } from './ipc/reply_guard';
import { resolveResource } from './resource';
import { RESOURCE_PRIVILEGED_SCHEME } from './resource_protocol';
import { AVATAR_PRIVILEGED_SCHEME } from './avatar_protocol';
import { MEDIA_PRIVILEGED_SCHEME } from './media_protocol';
import {
  registerResourceProtocol,
  registerAvatarProtocol,
  registerMediaProtocol,
} from './protocol_register';
import { getAppContext } from './context/app_context';
import { handleGroupKeywordHit } from './group_keyword_notify';
import { handleRecallNotification } from './recall_notify';
import { handleMailNotification } from './mail_notify';
import { checkForUpdate, installUpdateActions } from './update/updater';
import { stopMcpServer } from './mcp/server';
import { registerWeqAssistantIpc } from './weq_assistant/ipc';
import { startReleaseMonitor } from './daemon/release_monitor';
import { ensureDaemonRunning, syncGuiAutostartIntent } from './daemon/runtime';
import { disposeExternalMcp } from './mcp/external';
import { disposeElevatedCaptures } from './ipc/routers/wonderful_tools';
import { registerAnalyticsExportIpc } from './analytics_export';
import { registerChannelIpc } from './channel';
import { registerQzoneIpc } from './qzone';
import { registerFlashShareIpc } from './flash_share';
import { getMainWindow, setMainWindow } from './main_window';
import { createMainWindowLifecycle } from './main_window_lifecycle';
import { createRendererRecovery } from './renderer_recovery';
import { startRendererDiagnostics } from './renderer_diagnostics_runtime';
import { macApplicationMenu, nativeMenuLabels } from './application_menu';
import { registerEditUndoIpc, undoFocusedContent } from './edit_undo';
import { registerAttachHintIpc } from './attach_hint_ipc';
import { registerElevationIpc } from './elevation_ipc';
import {
  getLogDir,
  getLogger,
  setHost,
  type MediaElement,
  type WindowCloseBehavior,
} from '@weq/service';
import { electronHost } from './host';
import { systemAuthService } from './system_auth';
import { totpAuthService } from './totp_auth';
import { screenshotPage } from './link_shot';
const moduleDir = dirname(fileURLToPath(import.meta.url));

// Wayland 会话默认走 XWayland（见 linux_window_backend.ts）：这里**不能**用
// `appendSwitch`，ozone 后端必须在 Electron 启动参数里指定。开发时由
// electron.vite.config.ts 注入 `ELECTRON_CLI_ARGS`，打包版由 electron-builder 的
// `linux.executableArgs` 注入。

// Privileged-scheme registration must happen before app `ready`, and Electron
// honors only ONE `registerSchemesAsPrivileged` call — register every custom
// scheme together here.
protocol.registerSchemesAsPrivileged([
  RESOURCE_PRIVILEGED_SCHEME,
  AVATAR_PRIVILEGED_SCHEME,
  MEDIA_PRIVILEGED_SCHEME,
]);

const requireFromHere = createRequire(import.meta.url);
const { createIPCHandler } = requireFromHere(
  'electron-trpc/main',
) as typeof import('electron-trpc/main');

/**
 * Per-view window sizes. The home/bootstrap screen is compact; the chat view
 * gets a bit more room. Switching views resizes the window (see the
 * `window:set-layout` IPC), keeping the top-left corner fixed.
 */
const WINDOW_LAYOUTS = {
  home: { width: 1120, height: 580 },
  chat: { width: 1180, height: 760 },
} as const;

type WindowLayout = keyof typeof WINDOW_LAYOUTS;

const logger = getLogger().child({ scope: 'desktop-main' });

/** Created once; reopening attaches a window without registering IPC again. */
let mainIpcHandler: { attachWindow(win: BrowserWindow): void } | null = null;
const compositionWindows = new Map<number, BrowserWindow>();
/** System-tray icon; null until built (or if creation failed). */
let tray: Tray | null = null;
/** Set true right before a *real* quit so the `close` handler stops intercepting
 *  and lets the window actually close (托盘退出 / 确认框「完全退出」/ before-quit). */
let isQuitting = false;
let stopRendererDiagnostics: (() => void) | null = null;

const mainWindowLifecycle = createMainWindowLifecycle({
  canOpen: () => mainIpcHandler !== null && !isQuitting,
  getWindow: getMainWindow,
  setWindow: setMainWindow,
  createWindow,
  attachWindow: (win) => mainIpcHandler?.attachWindow(win),
});

function openMainWindow(): void {
  mainWindowLifecycle.open();
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
function buildTray(): void {
  if (tray) return;
  const labels = nativeMenuLabels(app.getPreferredSystemLanguages()[0] ?? app.getLocale());
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
        { label: labels.showWindow, click: openMainWindow },
        { type: 'separator' },
        {
          label: labels.quit,
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on('click', openMainWindow);
    tray.on('double-click', openMainWindow);
    logger.info('system tray created', { event: 'tray-create' });
  } catch (e) {
    logger.warn('failed to create system tray', {
      event: 'tray-create-failed',
      error: String(e),
    });
  }
}

function registerWindowLayoutIpc(): void {
  ipcMain.on('composition:control', (event, action: unknown) => {
    const child = compositionWindows.get(event.sender.id);
    if (child) controlCompositionWindow(child, action);
  });
  ipcMain.handle('window:set-layout', (event, layout: WindowLayout) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const size = WINDOW_LAYOUTS[layout] ?? WINDOW_LAYOUTS.home;
    // Don't fight a user who maximized/fullscreened the window.
    if (!win || win.isMaximized() || win.isFullScreen()) return;
    const [w, h] = win.getContentSize();
    if (w === size.width && h === size.height) return;
    win.setContentSize(size.width, size.height, true);
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
      getMainWindow()?.hide();
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
    } catch (_e) {
      return { success: false, error: '查询失败' };
    }
  });

  // OIDB completion for a chat file that isn't on disk. Resolves the download
  // URL (group vs c2c by the message's own kind), streams it into the media
  // cache, then reveals it in the OS file manager. Needs an online QQ.
  //
  // `fwdMsgId` marks a merged-forward sub-message: `msgId` is then the CARRYING
  // message and the element comes from its 40900 cache instead of the msg
  // tables. Such a file's original scene is unknowable, so both are tried.
  ipcMain.handle(
    'file:download',
    async (
      _event,
      input: {
        msgId: string;
        name: string;
        token: string;
        conv: string;
        fwdMsgId?: string;
        fwdKind?: 'group' | 'c2c';
      },
    ): Promise<{ success: boolean; error?: string; path?: string }> => {
      const ctx = getAppContext();
      const services = ctx.services;
      const boot = ctx.bootstrap;
      if (!services || !boot) return { success: false, error: '未打开账号' };
      const { msgId, name, token, conv, fwdMsgId = '', fwdKind = 'c2c' } = input;
      console.log('[file:download] request', { msgId, name, token, conv, fwdMsgId });
      logger.info('requested file download', {
        event: 'file-download-start',
        msgId,
        name,
        token,
        conv,
        fwdMsgId,
      });
      if (!msgId) return { success: false, error: '缺少消息 ID' };

      // Forwarded sub-message → element from the carrier's 40900 cache, and its
      // original scene is unknown (null). Otherwise → our own msg tables.
      let el: MediaElement | undefined;
      let convKind: 'group' | 'c2c' | null = null;
      if (fwdMsgId) {
        try {
          el =
            ((await services.msgs.findForwardedMediaElement(
              fwdKind,
              BigInt(msgId),
              BigInt(fwdMsgId),
              'file',
              token,
            )) as unknown as MediaElement | null) ?? undefined;
        } catch (e) {
          console.error('[file:download] forward cache lookup failed:', e);
          return { success: false, error: '转发消息查找失败' };
        }
      } else {
        let raw: Awaited<ReturnType<typeof services.msgs.getRawElements>>;
        try {
          raw = await services.msgs.getRawElements(BigInt(msgId));
        } catch (e) {
          console.error('[file:download] getRawElements failed:', e);
          return { success: false, error: '读取消息失败' };
        }
        if (!raw) {
          // 缺失消息弹窗拉到的漫游消息不在本地 msg 表：按 msgId 回退漫游缓存。
          const gap = await services.gapHistory.findMediaElement(msgId, 'file', token);
          if (!gap) return { success: false, error: '未找到该消息' };
          el = gap.element;
          convKind = gap.conv;
        } else {
          const matches = raw.elements.filter((e) => e.kind === 'file');
          console.log('[file:download] kind=%s, file elements=%d', raw.kind, matches.length);
          el = ((token
            ? matches.find((e) => (e as { fileToken?: string }).fileToken === token)
            : undefined) ?? matches[0]) as unknown as MediaElement | undefined;
          convKind = raw.kind;
        }
      }
      if (!el) return { success: false, error: '消息中未找到文件元素' };
      const elToken = el.fileToken ?? '';
      console.log('[file:download] element fileToken=%s', elToken);

      const fileName = name || el.fileName || elToken || 'download';
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

      const groupId = Number(conv) || 0;
      let url: string;
      try {
        url =
          convKind === null
            ? await services.mediaUrl.resolveFileUrlUnknownScene(groupId, el, fileName)
            : await services.mediaUrl.resolveFileUrl(convKind, groupId, el, fileName);
      } catch (e) {
        console.error('[file:download] OIDB resolve failed:', e);
        return {
          success: false,
          error: `OIDB 解析失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
      console.log('[file:download] resolved url:', url ? `${url.slice(0, 120)}?` : '(empty)');
      if (!url) return { success: false, error: 'OIDB 返回空链接（QQ 是否在线？）' };

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
        return { success: false, error: `下载失败：${outcome.reason}` };
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

/**
 * 把 NativeImage 写进系统剪贴板。
 *
 * Electron 44 对齐 W3C Clipboard API，移除了 `clipboard.writeImage`，统一走
 * 异步的 `clipboard.write([ClipboardItem])`；图片按 PNG 编码后以 `image/png`
 * MIME 交给系统。
 */
async function writeImageToClipboard(image: Electron.NativeImage): Promise<void> {
  await clipboard.write([
    new ClipboardItem({
      'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }),
    }),
  ]);
}

/** 文件名里剔掉路径分隔符等非法字符；空名字返回 ''。 */
function sanitizeExportName(name: string | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

/**
 * 图片灯箱底部的「另存为 / 复制到剪贴板」。
 *
 * 入参是渲染层手上那个 `src`（`weq-media://` 代理、CDN 直链，或乐观渲染的 `blob:`）。
 * 前两种主进程自己就能取：weq-media 是 `protocol.handle` 注册过的自定义 scheme
 * （privileges 里开着 supportFetchAPI），`net.fetch` 一样走得通；`blob:` 只活在渲染层，
 * 这里如实拒掉，让前端给一句人话提示。
 */
function registerMediaExportIpc(): void {
  ipcMain.handle(
    'media:export',
    async (
      event,
      input: { url?: string; name?: string; mode?: 'save' | 'clipboard' },
    ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> => {
      const url = input?.url ?? '';
      if (!url) return { ok: false, error: '没有可导出的图片来源' };
      if (!/^(https?:|weq-media:|weq-asset:)/i.test(url)) {
        return { ok: false, error: '这张图还没有落盘，暂时导出不了' };
      }
      try {
        const response = await net.fetch(url);
        if (!response.ok) return { ok: false, error: `读取图片失败（HTTP ${response.status}）` };
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0) return { ok: false, error: '读到的图片是空的' };

        if (input?.mode === 'clipboard') {
          const image = nativeImage.createFromBuffer(bytes);
          if (image.isEmpty()) return { ok: false, error: '这张图的格式没法写进剪贴板' };
          await writeImageToClipboard(image);
          return { ok: true };
        }

        let suggested = sanitizeExportName(input?.name);
        if (suggested && !/\.[a-z0-9]{2,5}$/i.test(suggested)) suggested += '.jpg';
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = win
          ? await dialog.showSaveDialog(win, { defaultPath: suggested || undefined })
          : await dialog.showSaveDialog({ defaultPath: suggested || undefined });
        if (result.canceled || !result.filePath) return { ok: false, canceled: true };
        await fs.promises.writeFile(result.filePath, bytes);
        logger.info('exported media from lightbox', {
          event: 'media-export',
          path: result.filePath,
          bytes: bytes.length,
        });
        return { ok: true, path: result.filePath };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '导出失败' };
      }
    },
  );
}

function registerLogIpc(): void {
  ipcMain.handle('logs:open-dir', async () => {
    const dir = getLogDir();
    if (!dir) {
      logger.warn('log directory requested before logger init', {
        event: 'open-log-dir-unavailable',
      });
      return false;
    }
    logger.info('opening log directory', { event: 'open-log-dir', dir });
    await electronHost.revealPath(dir);
    return true;
  });

  // 守护进程设置页「打开 docroot」——只在路径确实指向磁盘上已存在的目录时放行。
  ipcMain.handle('daemon:reveal-path', async (_event, path?: string) => {
    if (typeof path !== 'string' || !path || !fs.existsSync(path)) return false;
    await electronHost.revealPath(path);
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

/** WeQ 验证器（应用锁 TOTP）。密钥只在主进程持有，渲染层仅拿到状态 / 校验结果。 */
function registerTotpIpc(): void {
  ipcMain.handle('totp:getStatus', async () => {
    return totpAuthService.getStatus();
  });

  ipcMain.handle('totp:generate-setup', async () => {
    return totpAuthService.generateSetup();
  });

  ipcMain.handle('totp:cancel-setup', async () => {
    return totpAuthService.cancelSetup();
  });

  ipcMain.handle('totp:verify', async (_event, code: unknown) => {
    return totpAuthService.verify(code);
  });

  ipcMain.handle('totp:remove', async () => {
    return totpAuthService.remove();
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
      await writeImageToClipboard(image);
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
  const win = new BrowserWindow({
    width: 1120,
    height: 580,
    minWidth: 940,
    minHeight: 520,
    show: true,
    title: 'WeQ Desktop',
    autoHideMenuBar: true,
    backgroundColor: '#f0f0f0',
    titleBarStyle: 'hidden',
    ...floatingWindowTypeOption(),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(moduleDir, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      // 允许在渲染层用 <webview> 内嵌 QQ 空间 / 频道（见 QzoneView / ChannelView）。
      // webview 自身不挂本 preload，远程内容拿不到 tRPC 特权桥。
      webviewTag: true,
    },
  });

  const recovery = createRendererRecovery({
    unavailable: () => win.isDestroyed() || win.webContents.isDestroyed(),
    quitting: () => isQuitting,
    showDialog: async () => {
      const result = await dialog.showMessageBox(win, {
        type: 'error',
        title: 'WeQ 界面已停止运行',
        message: '界面进程意外退出，后台进程仍在运行。',
        detail:
          '可以重新加载界面或退出 WeQ。未保存的界面内容可能丢失；已提交操作的结果可能尚未显示，请先核对，不要直接重复提交。重新加载不会自动重发操作。',
        buttons: ['重新加载界面', '退出 WeQ', '稍后处理'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      return result.response;
    },
    reload: () => win.webContents.reload(),
    quit: () => {
      isQuitting = true;
      app.quit();
    },
    record: (event, details) =>
      logger.warn('main renderer recovery', {
        event: `renderer-recovery-${event}`,
        webContentsId: win.webContents.id,
        ...details,
      }),
  });
  win.webContents.on('render-process-gone', (_event, details) => recovery.gone(details));
  win.webContents.on('did-finish-load', () => recovery.loaded());
  win.once('closed', () => recovery.dispose());

  const reveal = () => {
    if (win.isDestroyed()) return;
    win.show();
    win.restore();
    win.focus();
    try {
      win.setAlwaysOnTop(true);
      win.setAlwaysOnTop(false);
    } catch {
      /* ignore */
    }
  };

  win.on('ready-to-show', reveal);
  // Fallback: in some environments `ready-to-show` can be delayed or missed
  // (e.g. compositor/driver quirks). Guarantee visibility once content loads.
  win.webContents.on('did-finish-load', reveal);
  setTimeout(reveal, 1000);

  // Apply the user-configured close action (设置 → 全局设置 → 关闭按钮):
  //   'quit' → quit the app on every platform;
  //   'tray' → hide to the system tray, keep the process alive;
  //   'ask'  → ask the renderer to show the 关闭确认框 (default, first time).
  win.on('close', (e) => {
    if (isQuitting || win !== getMainWindow()) return;
    if (recovery.needsRecovery()) {
      e.preventDefault();
      recovery.request();
      return;
    }
    const behavior = resolveCloseBehavior();
    if (behavior === 'quit') {
      isQuitting = true;
      app.quit();
      return;
    }
    e.preventDefault();
    if (behavior === 'tray' && tray) {
      win.hide();
      return;
    }
    // 'ask' — or 'tray' but the tray failed to build → fall back to asking.
    win.webContents.send('window:confirm-close', {
      canMinimizeToTray: Boolean(tray),
    });
  });

  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const options = compositionPopupOptions(url, frameName);
    if (options) return { action: 'allow', overrideBrowserWindowOptions: options };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child, details) => {
    if (details.frameName !== 'weq-compose' || details.url !== 'about:blank') return;
    const owner = win.webContents.id;
    compositionWindows.set(owner, child);
    const reportState = () => {
      if (!win.isDestroyed() && !child.isDestroyed())
        win.webContents.send('composition:state', { maximized: child.isMaximized() });
    };
    child.on('maximize', reportState);
    child.on('unmaximize', reportState);
    reportState();
    child.on('closed', () => {
      if (compositionWindows.get(owner) === child) compositionWindows.delete(owner);
    });
    child.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    child.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url !== 'about:blank') void shell.openExternal(url);
    });
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(moduleDir, '../renderer/index.html'));
  }
  return win;
}

// Single-instance guard: with the app now living in the tray, a second launch
// should just re-reveal the existing window rather than spawn another
// background process. The non-primary instance quits immediately.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', openMainWindow);
}

void app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  electronApp.setAppUserModelId('app.weq.desktop');

  // win32: resolve QQ's tencent:// handler (timwp.exe) before building the
  // platform, so install-path detection can anchor on it and skip the fragile
  // registry lookup. linux QQ doesn't register the scheme — skip the probe.
  if (process.platform !== 'linux') {
    await probeQqProtocolHandler();
  }

  // Order matters: AppContext (loads native + platform) before IPC handler.
  // The host bridge must be installed before any router runs.
  setHost(electronHost);
  installUpdateActions();
  initAppContext();
  const logDirectory = getLogDir();
  if (logDirectory)
    stopRendererDiagnostics = startRendererDiagnostics({
      directory: logDirectory,
      mainWebContentsId: () => {
        const window = getMainWindow();
        return window && !window.isDestroyed() ? window.webContents.id : undefined;
      },
    });
  // 链接卡片抓不到 og:image 时的兜底封面。截图要跑一个真浏览器，服务层不认识
  // Electron，所以实现在这里注入（app_context 保持 Electron-free，web 端共用它）。
  getAppContext().bootstrap?.linkPreview.setScreenshotHook(screenshotPage);
  // 群关键词命中：弹系统通知（群头像）+ 写 unread 2006 高亮。服务层不认识
  // Electron，所以实现注入在这里（app_context 保持 Electron-free）。
  setGroupKeywordNotifier(handleGroupKeywordHit);
  // 防撤回：拦到新撤回时按会话开关弹系统通知（服务层注入，保持 Electron-free）。
  setRecallNotifier(handleRecallNotification);
  setMailNotifier(handleMailNotification);
  // 意图感知本地引擎（Laya ONNX worker）：bridge 认识 Electron（userData 路径、
  // fork），同样从这里注入控制面；web 端不注入，localAvailable 恒为 false。
  setIntentSenseLocalEngine(getIntentSenseLocalEngine());
  logger.info('electron app ready', { event: 'app-ready' });

  registerResourceProtocol();
  registerAvatarProtocol();
  registerMediaProtocol();
  registerWindowLayoutIpc();
  registerMediaIpc();
  registerMediaExportIpc();
  registerLogIpc();
  registerSystemAuthIpc();
  registerTotpIpc();
  // 启动时立即在后台探测 Windows Hello 可用性，避免 UI 首次调用时卡顿。
  systemAuthService.warmup();
  registerCaptureIpc();
  registerAnalyticsExportIpc();
  registerChannelIpc();
  registerQzoneIpc();
  registerFlashShareIpc();
  registerWeqAssistantIpc();
  registerAttachHintIpc();
  registerElevationIpc();
  registerEditUndoIpc();

  app.on('browser-window-created', (_, win) => {
    optimizer.watchWindowShortcuts(win);
  });

  mainIpcHandler = createIPCHandler({
    router: appRouter,
    windows: [],
    createContext: async ({ event }) => {
      // electron-trpc 实际使用 ipcMain.on，但类型误声明为 InvokeEvent。
      guardTrpcReply(event as IpcMainEvent);
      return {};
    },
  });
  openMainWindow();
  logger.info('main window created', { event: 'create-window' });
  buildTray();
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        macApplicationMenu(
          openMainWindow,
          app.getPreferredSystemLanguages()[0] ?? app.getLocale(),
          undoFocusedContent,
        ),
      ),
    );
  }

  // Silent background update check (packaged builds only). Result is cached and
  // pushed to the renderer via the `update.onEvent` subscription → settings red
  // dot. Deferred so it never competes with first paint; failures are ignored.
  if (app.isPackaged) {
    setTimeout(() => void checkForUpdate(true).catch(() => {}), 3000);
  }

  // 守护进程 release 提醒循环（发现新版本弹系统通知）：始终挂着，每 30s 读一次
  // 守护进程状态；守护进程侧轮询未开启 / 不在时自然为 no-op。推文由打包版
  // 应用内更新检查（update_tweet）统一负责，不在这里重复写。
  startReleaseMonitor();

  // 守护进程默认拉起：应用启动即检查 / 拉起 weq-daemon（含版本对齐与稳定落位），
  // 不再等「WeQ 助手」开关。best-effort：二进制缺失 / 拉起失败只记日志，不阻塞
  // 启动；设置页展示实时状态。
  void ensureDaemonRunning()
    // 起来之后，再把「开机拉起 WeQ」的意图 + 当前 exe 路径刷进守护进程记忆。
    // GUI 自己不注册任何原生自启 —— 全机唯一的自启注册是守护进程那一份。
    .then(() => syncGuiAutostartIntent())
    .catch((error) => {
      logger.warn('failed to ensure weq-daemon on startup', {
        event: 'daemon-startup-failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });

  app.on('activate', openMainWindow);
});

app.on('window-all-closed', () => {
  // With the tray keeping the process alive, closing the window normally hides
  // it (never reaching here). Explicit quit actions call app.quit themselves;
  // macOS can keep running after a window is destroyed and reopen on activation.
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

// A real quit is underway (tray「退出」/ 确认框「完全退出」/ Cmd+Q / OS shutdown):
// flip the flag so the `close` handler stops intercepting, and drop the tray.
app.on('before-quit', () => {
  isQuitting = true;
  stopRendererDiagnostics?.();
  stopRendererDiagnostics = null;
  try {
    getAppContext().services?.roamingBackfill.dispose();
  } catch (error) {
    logger.warn('failed to save roaming pause on quit', {
      event: 'roaming-quit-checkpoint',
      error: String(error),
    });
  }
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
// was never explicitly closed (clearAccount also stops it). The weq-daemon
// companion process is deliberately NOT touched on quit — its lifecycle
// belongs to autostart / the user, and it keeps serving the QQ cards after
// WeQ is gone.
app.on('will-quit', () => {
  void stopMcpServer();
  void disposeExternalMcp();
  // 提权抓包子进程是 root 的 —— 退出时主动送走（子进程那边也会在环回连接断开时
  // 自己收尾，这里只是不让它多活一拍）。
  disposeElevatedCaptures();
});

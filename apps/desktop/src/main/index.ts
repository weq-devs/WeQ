import {
  accountIpc,
  accountRuntimeFor,
  accountSession,
  bindAccountSession,
} from './window_account_runtime';
import { controlCompositionWindow } from './composition_window';
import { flushConversationCalendarResults } from './ipc/routers/conversation_calendar';
import { applicationToolPopupOptions, createToolWindowRegistry } from './tool_window';
import {
  allowMessageImageWindow,
  isMessageImageWindow,
  registerMessageImageIpc,
  registerMessageImageWindow,
} from './message_image';
import { labelPerformanceWindow } from './performance_process_labels';
import { installCallDisplayMediaHandler } from './call_display_media';
import {
  appImageRelaunchCommand,
  floatingWindowTypeOption,
  ozoneRelaunchArgs,
} from './linux_window_backend';
import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  Menu,
  nativeImage,
  net,
  protocol,
  shell,
  screen,
  session,
  type Session,
  type Tray,
  type IpcMainEvent,
} from 'electron';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { WINDOW_LAYOUTS, applyWindowLayout, type WindowLayout } from './window_layout';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  initAppContext,
  disposeAppContext,
  requirePlatform,
  setGroupKeywordNotifier,
  setIntentSenseLocalEngine,
  setRecallNotifier,
  setMailNotifier,
} from './context/app_context';
import {
  AccountRuntime,
  currentAccountRuntime,
  primaryAccountRuntime,
} from './context/account_runtime';
import { migrateStaticAccountIdentity } from './static_account_identity_migration';
import { getIntentSenseLocalEngine } from './intent_sense/bridge';
import { probeQqProtocolHandler } from './context/qq_protocol';
import { appRouter } from './ipc/router';
import { desktopStartupAccount, openStartupAccount, startupWindowLayout } from './startup_account';
import { guardTrpcReply } from './ipc/reply_guard';
import { resolveResource } from './resource';
import { RESOURCE_PRIVILEGED_SCHEME } from './resource_protocol';
import { AVATAR_PRIVILEGED_SCHEME } from './avatar_protocol';
import { MEDIA_PRIVILEGED_SCHEME } from './media_protocol';
import { registerAccountProtocols, registerMediaThumbnailIpc } from './protocol_register';
import { registerUdpCaptureStorage } from './udp_capture_register';
import { getAppContext, accountEventBus } from './context/app_context';
import { electronAnnouncementFetch, installDesktopNetwork } from './network';
import { configureReleaseFeeds } from './update/release_feed';
import { desktopAnnouncementPlatform, startAnnouncements } from './announcements';
import { handleGroupKeywordHit } from './group_keyword_notify';
import { handleRecallNotification } from './recall_notify';
import { handleMailNotification } from './mail_notify';
import { startAutomaticUpdateChecks, installUpdateActions } from './update/updater';
import { stopMcpServer } from './mcp/server';
import { WebCore } from './web/application';
import { registerWeqAssistantIpc } from './weq_assistant/ipc';
import { assistantResourceServer } from './weq_assistant/server';
import { disposeExternalMcp } from './mcp/external';
import { disposeElevatedCaptures } from './ipc/routers/wonderful_tools';
import { disposeUdpCaptures } from './ipc/routers/udp_capture';
import { registerAnalyticsExportIpc } from './analytics_export';
import { registerChannelIpc } from './channel';
import { registerQzoneIpc } from './qzone';
import { registerFlashShareIpc } from './flash_share';
import { getMainWindow, setMainWindow } from './main_window';
import { windowControlsStyle, type WindowControlsStyle } from '../shared/window_controls';
import { installWindowChrome, publishWindowChrome, registerWindowChromeIpc } from './window_chrome';
import {
  registerWindowControlsRefresh,
  registerWindowControlsPreference,
} from './window_controls_events';
import { installWindowControls } from './window_controls';
import {
  createMainWindowLifecycle,
  shouldRevealMainWindowOnActivation,
} from './main_window_lifecycle';
import { registerMainWindowReveal, revealMainWindow } from './main_window_lifecycle_instance';
import {
  AUTOSTART_ARG,
  installStartupWindowReveal,
  isAutostartLaunch,
  MANUAL_RESTART_ARG,
  shouldShowStartupWindow,
} from './startup_window';
import {
  registerAppQuitCleanup,
  registerAppQuitPreparation,
  registerWindowUnloadConfirmation,
} from './app_quit_lifecycle';
import { createRendererRecovery } from './renderer_recovery';
import { registerRendererRecoveryIpc } from './renderer_recovery_ipc';
import {
  finishPerformanceRecordingReset,
  installPerformanceMonitor,
  type PerformanceMonitor,
} from '@weq/service/performance';
import { applyRestoredHostPreferences } from './context/backup_host_preferences';
import { getBackupContext, initBackupContext } from './context/backup_context';
import { createDesktopCollector } from './performance_monitor';
import { performanceDatabaseDetails } from './performance_database';
import { databaseCheckups } from './db_checkup';
import { databaseMaintenance, waitForDatabaseRestore } from './ipc/routers/db_repair';
import {
  guardDatabaseMaintenanceQuit,
  guardDatabaseMaintenanceWindow,
} from './db_maintenance_lifecycle';
import { desktopApplicationMenu, macApplicationMenu } from './application_menu';
import { publishDevelopmentWindow } from './development_window';
import { createSystemTray } from './system_tray';
import { registerEditUndoIpc, undoFocusedContent, redoFocusedContent } from './edit_undo';
import { registerEditContextMenu } from './edit_context_menu';
import { registerCallVideoIpc } from './call_video_ipc';
import { currentGroupCall } from './group_call';
import { registerAttachHintIpc } from './attach_hint_ipc';
import { backgroundServicesRunning } from './background_services';
import { registerElevationIpc } from './elevation_ipc';
import { registerLongTermAuthorizationIpc } from './authorization/ipc';
import {
  weqBackupRestoreStatus,
  flushFileLogger,
  getLogDir,
  getLogger,
  configureDevelopmentLogging,
  initRuntimeLogging,
  logErrorContext,
  hasPendingWeqBackupRestore,
  setHost,
  type ExportSavePolicy,
  type WindowCloseBehavior,
} from '@weq/service';
import {
  cancelApplicationRestart,
  electronHost,
  migrateLegacyAutostart,
  restartApplication,
} from './host';
import { mediaSaveRouter } from './ipc/routers/media_save';
import { systemAuthService } from './system_auth';
import { totpAuthService } from './totp_auth';
import { screenshotPage } from './link_shot';
import { guardStorageCleanupStartup } from './storage_cleanup';
import { weqAppDataRoot } from '@weq/platform';
import {
  AccountInstances,
  accountIsRunning,
  accountPickerDirectories,
  accountPickerTarget,
  developmentStartupConfigId,
  focusAccountTarget,
  instanceDirectories,
  type AccountInstanceTarget,
  instanceTarget,
  isDevelopmentPicker,
  prepareAccountPicker,
  prepareInstanceAccount,
} from './account_instances';
import { prepareMacAccountWindowSession } from './account_window_session';
import { accountStorageMigrationPath, migrateAccountStorage } from './account_storage_migration';
import { DesktopStorage, setDesktopStorage } from './desktop_storage';
import { registerAccountWorker, savedAccountTarget } from './desktop_services/accounts';
import { DesktopServiceRegistry } from './desktop_services/control';
import { connectDesktopServices, desktopWebStatus } from './desktop_services/host';
import { setAccountInstanceScope } from './account_instance_scope';
import type { AccountInstanceInfo } from '../shared/account_instances';
const moduleDir = dirname(fileURLToPath(import.meta.url));

// Wayland 会话默认走 XWayland（见 linux_window_backend.ts）：这里**不能**用
// `appendSwitch`，ozone 后端必须在 Electron 启动参数里指定。开发时由
// electron.vite.config.ts 注入 `ELECTRON_CLI_ARGS`；打包版只有从 `.desktop` 启动
// （AppImage 走系统菜单）才带得上参数，直接执行 AppImage / tar.gz 解压跑都不经过
// `.desktop`，所以下面兜底重启一次。必须在 requestSingleInstanceLock 之前——
// 否则重启出来的新进程会撞上本进程持有的单实例锁而直接退出。
function relaunchForOzoneBackend(): void {
  const relaunch = ozoneRelaunchArgs();
  if (!relaunch) return;
  process.env.WEQ_OZONE_RELAUNCHED = '1';
  if (relaunch.execPath) {
    const command = appImageRelaunchCommand(relaunch.execPath, relaunch.args);
    spawn(command.execPath, command.args, { detached: true, stdio: 'ignore' }).unref();
  } else {
    app.relaunch({ args: relaunch.args });
  }
  app.exit(0);
}
relaunchForOzoneBackend();

const defaultDataRoot = weqAppDataRoot();
const defaultElectronDataRoot = app.getPath('userData');
const serviceRegistry = new DesktopServiceRegistry(defaultDataRoot);
const accountTarget = instanceTarget(process.argv);
const pickerId = accountPickerTarget(process.argv);
const focusTarget = focusAccountTarget(process.argv);
const developmentProfile = !app.isPackaged && isDevelopmentPicker(pickerId);
if (developmentProfile && pickerId) {
  const { userData } = accountPickerDirectories(defaultDataRoot, pickerId);
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
}

interface AccountWindowState {
  runtime: AccountRuntime;
  instances: AccountInstances;
  profile: string;
  assignedUin?: string;
  startupConfigId?: string;
  title?: string;
  session?: Session;
  storage?: DesktopStorage;
  stopWorker?: () => void;
  stopProtocols?: () => void;
  closing?: boolean;
}

const primaryWindow: AccountWindowState = {
  runtime: primaryAccountRuntime,
  instances: new AccountInstances(defaultDataRoot, accountTarget?.uin, pickerId),
  profile: app.getPath('userData'),
  assignedUin: accountTarget?.uin,
  startupConfigId: accountTarget?.configId,
};
const accountWindows = new Map<AccountRuntime, AccountWindowState>([
  [primaryAccountRuntime, primaryWindow],
]);
const windowState = () => accountWindows.get(currentAccountRuntime()) ?? primaryWindow;
let lastWindowRuntime = primaryAccountRuntime;
let stopDesktopServices: (() => Promise<void>) | undefined;

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

configureDevelopmentLogging(!app.isPackaged, 'desktop-main');
const logger = getLogger().child({ scope: 'desktop-main' });

/** Created once; reopening attaches a window without registering IPC again. */
let mainIpcHandler: { attachWindow(win: BrowserWindow): void } | null = null;
const compositionWindows = new Map<number, BrowserWindow>();
const toolWindows = createToolWindowRegistry();
const repairWindowScopes = new Map<number, { uin: string; configId?: string }>();
/** System-tray icon; null until built (or if creation failed). */
let tray: Tray | null = null;
/** Set true right before a *real* quit so the `close` handler stops intercepting
 *  and lets the window actually close (托盘退出 / Cmd+Q / before-quit). */
let isQuitting = false;
let performanceMonitor: PerformanceMonitor | undefined;
let performanceQuitReady = false;
let performanceQuitPending = false;
let mainWindowRequested = false;
const rendererRecoveries = new Map<number, ReturnType<typeof createRendererRecovery>>();
const windowLayouts = new WeakMap<BrowserWindow, WindowLayout>();
const windowStyles = new WeakMap<BrowserWindow, WindowControlsStyle>();

function requestedControls(layout: WindowLayout): WindowControlsStyle {
  return windowControlsStyle(
    process.platform,
    getAppContext().bootstrap?.userConfig.getSettings().windowsStyleControls ?? false,
    layout,
  );
}

function updateMainWindowControls(win: BrowserWindow, layout: WindowLayout): void {
  if (process.platform !== 'darwin') return;
  const style = requestedControls(layout);
  win.setWindowButtonVisibility(style === 'native');
  windowStyles.set(win, style);
  win.webContents.send('window:controls-changed', style);
  publishWindowChrome(win, style);
}

registerWindowControlsRefresh(() => {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) updateMainWindowControls(win, windowLayouts.get(win) ?? 'home');
});
registerWindowControlsPreference(
  () => getAppContext().bootstrap?.userConfig.getSettings().windowsStyleControls ?? false,
);

function registerWindowLifecycle(runtime: AccountRuntime) {
  const lifecycle = createMainWindowLifecycle({
    canOpen: () => mainIpcHandler !== null && !isQuitting,
    getWindow: runtime.bind(getMainWindow),
    setWindow: runtime.bind(setMainWindow),
    createWindow,
    attachWindow: (win) => mainIpcHandler?.attachWindow(win),
  });
  const scoped = { open: runtime.bind(lifecycle.open) };
  runtime.run(() => registerMainWindowReveal(scoped));
  return scoped;
}
const mainWindowLifecycle = registerWindowLifecycle(primaryAccountRuntime);

function openMainWindow(): void {
  mainWindowRequested = true;
  revealMainWindow();
}

function revealLastWindow(): void {
  lastWindowRuntime.run(openMainWindow);
}

function hasOtherAccountWindow(runtime: AccountRuntime): boolean {
  return [...accountWindows.keys()].some((other) => {
    if (other === runtime) return false;
    const window = other.run(getMainWindow);
    return window && !window.isDestroyed();
  });
}

function focusOpenAccount(uin: string): boolean {
  for (const entry of accountWindows.values()) {
    if (entry.closing || !entry.instances.owns(uin)) continue;
    entry.runtime.run(openMainWindow);
    return true;
  }
  return false;
}

function bindDesktopWindowSession(entry: AccountWindowState, windowSession: Session): void {
  entry.session = windowSession;
  const unbind = bindAccountSession(windowSession, entry.runtime);
  const unregisterProtocols = registerAccountProtocols(windowSession, entry.runtime);
  installCallDisplayMediaHandler(windowSession);
  entry.stopProtocols = () => {
    unregisterProtocols();
    unbind();
  };
}

async function openAccountWindow(target?: AccountInstanceTarget): Promise<boolean> {
  if (isQuitting || !mainIpcHandler) return false;
  if (target && focusOpenAccount(target.uin)) return true;
  const id = prepareAccountPicker();
  const { userData } = target
    ? instanceDirectories(defaultDataRoot, target.uin)
    : accountPickerDirectories(defaultDataRoot, id);
  const runtime = new AccountRuntime();
  const entry: AccountWindowState = {
    runtime,
    profile: userData,
    instances: new AccountInstances(defaultDataRoot, target?.uin, target ? undefined : id),
    assignedUin: target?.uin,
    startupConfigId: target?.configId,
  };
  try {
    if (target) {
      const record = prepareInstanceAccount(defaultDataRoot, target);
      entry.instances.claim(target.uin);
      entry.title = `WeQ · ${record.displayName || record.uin}`;
    }
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    accountWindows.set(runtime, entry);
    const sessionPath =
      process.platform === 'darwin'
        ? await prepareMacAccountWindowSession(app.getPath('sessionData'), userData)
        : userData;
    if (isQuitting || entry.closing) {
      await disposeAccountWindow(entry);
      return false;
    }
    return await runtime.run(async () => {
      entry.storage = new DesktopStorage(defaultDataRoot);
      setDesktopStorage(entry.storage);
      setAccountInstanceScope(entry.instances);
      bindDesktopWindowSession(entry, session.fromPath(sessionPath));
      initAppContext(defaultDataRoot, defaultDataRoot);
      getAppContext().bootstrap?.linkPreview.setScreenshotHook(screenshotPage);
      accountEventBus.on('closing', () => electronHost.setApplicationBadge?.(0));
      const lifecycle = registerWindowLifecycle(runtime);
      await registerDesktopAccount(entry).catch((error: unknown) =>
        logger.warn('桌面账号服务初始化失败', { error: String(error) }),
      );
      if (isQuitting) {
        await disposeAccountWindow(entry);
        return false;
      }
      const config = getAppContext().bootstrap?.userConfig;
      if (target && config)
        void desktopStartupAccount().start(() =>
          openStartupAccount(
            config,
            appRouter.createCaller({}).bootstrap,
            process.platform === 'darwin',
            target.configId,
          ),
        );
      return lifecycle.open() !== null;
    });
  } catch (error) {
    await disposeAccountWindow(entry);
    throw error;
  }
}

async function disposeAccountWindow(entry: AccountWindowState): Promise<void> {
  if (entry.closing) return;
  entry.closing = true;
  entry.instances.stopOpening();
  entry.stopWorker?.();
  entry.stopProtocols?.();
  try {
    await entry.runtime.run(disposeAppContext);
  } finally {
    entry.storage?.close();
    entry.instances.dispose();
    accountWindows.delete(entry.runtime);
    if (lastWindowRuntime === entry.runtime) lastWindowRuntime = primaryAccountRuntime;
  }
}

function requestAccountPicker(): void {
  void openAccountWindow().catch((error) => {
    logger.error('failed to open an account selection window', { error: String(error) });
    dialog.showErrorBox('无法新建窗口', String(error));
  });
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

function restartFromMenu(): void {
  void restartApplication().catch((error) => {
    logger.error('failed to restart WeQ from menu', { error: String(error) });
    dialog.showErrorBox('无法重启 WeQ', String(error));
  });
}

/** 创建一次系统托盘，点击时复用主窗口的显示/重建入口。 */
function buildTray(): void {
  if (tray) return;
  try {
    tray = createSystemTray({
      locale: app.getPreferredSystemLanguages()[0] ?? app.getLocale(),
      openMainWindow: revealLastWindow,
      newWindow: requestAccountPicker,
      restart: restartFromMenu,
      quit: () => app.quit(),
    });
    logger.info('system tray created', { event: 'tray-create' });
  } catch (e) {
    logger.warn('failed to create system tray', {
      event: 'tray-create-failed',
      error: String(e),
    });
  }
}

function registerWindowLayoutIpc(): void {
  registerWindowChromeIpc((win) => windowStyles.get(win) ?? 'windows');
  accountIpc.handle('window:get-controls', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? (windowStyles.get(win) ?? 'windows') : 'windows';
  });
  accountIpc.on('composition:control', (event, action: unknown) => {
    const child = compositionWindows.get(event.sender.id);
    if (child) controlCompositionWindow(child, action);
  });
  accountIpc.on('tool-window:focus', (event, name: unknown) => {
    toolWindows.focus(event.sender.id, name);
  });
  accountIpc.on('db-repair:scope', (event, scope: unknown) => {
    if (!scope || typeof scope !== 'object' || !('uin' in scope) || typeof scope.uin !== 'string')
      return;
    repairWindowScopes.set(event.sender.id, {
      uin: scope.uin,
      configId:
        'configId' in scope && typeof scope.configId === 'string' ? scope.configId : undefined,
    });
  });
  accountIpc.handle('window:set-layout', (event, layout: WindowLayout) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || (layout !== 'home' && layout !== 'chat')) return;
    // Linux 无运行时装饰开关，仅在账号页/工作区切换时重建，保留后台账号会话。
    // 设置过程中不重载渲染层，以免丢掉未保存的编辑和已打开的工具窗。
    if (
      process.platform === 'linux' &&
      win === getMainWindow() &&
      windowLayouts.get(win) !== layout &&
      windowStyles.get(win) !== requestedControls(layout)
    ) {
      const next = createWindow(win.isVisible(), layout);
      setMainWindow(next);
      next.once('closed', () => {
        if (getMainWindow() === next) setMainWindow(null);
      });
      mainIpcHandler?.attachWindow(next);
      setImmediate(() => {
        if (!win.isDestroyed()) win.destroy();
      });
      return;
    }
    windowLayouts.set(win, layout);
    updateMainWindowControls(win, layout);
    applyWindowLayout(win, layout, screen.getDisplayMatching(win.getBounds()).workArea);
  });

  accountIpc.on('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  accountIpc.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  accountIpc.on('window-close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // Reply from the renderer's 关闭确认框 (only sent when behavior === 'ask').
  //   'tray' → hide to tray; 'quit' → real quit; 'cancel' → do nothing.
  accountIpc.on('window:respond-close', (_event, action: 'tray' | 'quit' | 'cancel') => {
    if (action === 'tray') {
      getMainWindow()?.hide();
    } else if (action === 'quit') {
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
  accountIpc.handle(
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

  accountIpc.handle('file:reveal', async (_event, msgId: string) => {
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

  // 兼容旧入口；资源解析与保存只走公共单文件任务。
  accountIpc.handle(
    'file:download',
    async (
      _event,
      input: {
        msgId: string;
        name: string;
        token: string;
        conv: string;
        fwdMsgId?: string;
        fwdKind?: 'c2c' | 'group';
        savePolicy?: ExportSavePolicy;
        expectedAccountUin?: string;
        expectedAccountConfigId?: string;
      },
    ) => {
      try {
        const taskId = await mediaSaveRouter.createCaller({}).save({
          source: {
            kind: 'chat-file',
            msgId: input.msgId,
            name: input.name,
            token: input.token,
            conv: input.conv,
            fwdMsgId: input.fwdMsgId || undefined,
            fwdKind: input.fwdKind,
          },
          savePolicy: input.savePolicy,
          expectedAccountUin: input.expectedAccountUin,
          expectedAccountConfigId: input.expectedAccountConfigId,
        });
        return taskId ? { success: true, taskId } : { success: false, canceled: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : '文件保存失败' };
      }
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

/**
 * 图片灯箱底部的「另存为 / 复制到剪贴板」。
 *
 * 入参是渲染层手上那个 `src`（`weq-media://` 代理、CDN 直链，或乐观渲染的 `blob:`）。
 * 前两种主进程自己就能取：weq-media 是 `protocol.handle` 注册过的自定义 scheme
 * （privileges 里开着 supportFetchAPI），`net.fetch` 一样走得通；`blob:` 只活在渲染层，
 * 这里如实拒掉，让前端给一句人话提示。
 */
function registerMediaExportIpc(): void {
  accountIpc.handle(
    'media:export',
    async (
      _event,
      input: {
        url?: string;
        name?: string;
        mode?: 'save' | 'clipboard';
        savePolicy?: ExportSavePolicy;
        expectedAccountUin?: string;
        expectedAccountConfigId?: string;
      },
    ): Promise<{
      ok: boolean;
      canceled?: boolean;
      taskId?: string;
      path?: string;
      error?: string;
    }> => {
      const url = input?.url ?? '';
      if (!url) return { ok: false, error: '没有可导出的图片来源' };
      if (!/^(https?:|weq-media:|weq-asset:)/i.test(url))
        return { ok: false, error: '这张图还没有落盘，暂时导出不了' };
      try {
        if (input.mode !== 'clipboard') {
          const taskId = await mediaSaveRouter.createCaller({}).save({
            source: { kind: 'url', url, name: input.name },
            savePolicy: input.savePolicy,
            expectedAccountUin: input.expectedAccountUin,
            expectedAccountConfigId: input.expectedAccountConfigId,
          });
          return taskId ? { ok: true, taskId } : { ok: false, canceled: true };
        }
        const response = await (accountSession()?.fetch(url) ?? net.fetch(url));
        if (!response.ok) return { ok: false, error: `读取图片失败（HTTP ${response.status}）` };
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length) return { ok: false, error: '读到的图片是空的' };
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) return { ok: false, error: '这张图的格式没法写进剪贴板' };
        await writeImageToClipboard(image);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '导出失败' };
      }
    },
  );
}

function registerLogIpc(): void {
  accountIpc.handle('logs:open-dir', async () => {
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

  /**
   * 渲染层 → 主进程日志文件（`weq.debugLog`）。
   *
   * 通话视频的解码全在渲染层，而渲染层的 `console.*` **不会**进日志文件 ——
   * 「等待对方画面」这类问题因此一直只能盲猜。这个通道只接受结构化字段，
   * 走同一个 `getLogger()`，落进同一天的日志里，便于和主进程的 `scope=call`
   * 行按时间对齐。
   *
   * 刻意**不**转发 `console` 全量：主进程 `console-message` 会把整个渲染层的
   * 噪声（React 警告、第三方库日志）都灌进文件。调用方显式调用才记。
   */
  accountIpc.on('logs:renderer', (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const record = payload as { level?: unknown; message?: unknown; context?: unknown };
    if (typeof record.message !== 'string' || record.message.length > 2000) return;
    const level =
      record.level === 'warn' || record.level === 'error' || record.level === 'debug'
        ? record.level
        : 'info';
    const context =
      record.context && typeof record.context === 'object'
        ? (record.context as Record<string, unknown>)
        : {};
    logger[level](record.message, { scope: 'renderer', ...context });
  });
}

function registerSystemAuthIpc(): void {
  accountIpc.handle('systemAuth:getStatus', async () => {
    return systemAuthService.resolveStatus();
  });

  accountIpc.handle('systemAuth:verify', async (event, reason?: string) => {
    const targetWin = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    return systemAuthService.verify(reason, targetWin);
  });
}

/** WeQ 验证器（应用锁 TOTP）。密钥只在主进程持有，渲染层仅拿到状态 / 校验结果。 */
function registerTotpIpc(): void {
  accountIpc.handle('totp:getStatus', async () => {
    return totpAuthService.getStatus();
  });

  accountIpc.handle('totp:generate-setup', async () => {
    return totpAuthService.generateSetup();
  });

  accountIpc.handle('totp:cancel-setup', async () => {
    return totpAuthService.cancelSetup();
  });

  accountIpc.handle('totp:verify', async (_event, code: unknown) => {
    return totpAuthService.verify(code);
  });

  accountIpc.handle('totp:remove', async () => {
    return totpAuthService.remove();
  });
}

/**
 * 截图：抓取发起窗口的客户区（不含桌面 / 标题栏外区域）写入系统剪贴板。
 * 走 webContents.capturePage()——隐私遮罩是 DOM 上的 filter，会如实截到糊后的
 * 效果，故截图天然与隐私模式联动。截完即可粘贴到聊天 / 文档，暂不落盘。
 */
function registerCaptureIpc(): void {
  accountIpc.handle('capture:window', async (event) => {
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

function createWindow(
  showInitially = true,
  layout: WindowLayout = startupWindowLayout(
    Boolean(getAppContext().account),
    desktopStartupAccount().pending,
    getAppContext().bootstrap?.userConfig,
    windowState().startupConfigId,
  ),
): BrowserWindow {
  const entry = windowState();
  const { runtime } = entry;
  const icon = resolveWindowIcon();
  const controls = requestedControls(layout);
  // On tiling Wayland WMs (Hyprland/sway) new toplevels tile by default. Ask
  // the WM to float us by advertising a non-'normal' window type — 'toolbar'
  // is the least invasive one that Hyprland/sway treat as floating (unlike
  // 'splash', it keeps the taskbar entry). Opt-out with WEQ_WINDOW_TYPE=normal
  // (or override to another value) so this can be disabled per-environment.
  const win = new BrowserWindow({
    ...WINDOW_LAYOUTS[layout],
    useContentSize: true,
    show: false,
    title: entry.title ?? 'WeQ Desktop',
    autoHideMenuBar: true,
    backgroundColor: '#f0f0f0',
    titleBarStyle: process.platform === 'linux' && controls === 'native' ? 'default' : 'hidden',
    ...floatingWindowTypeOption(),
    ...(icon ? { icon } : {}),
    webPreferences: {
      session: entry.session,
      preload: join(moduleDir, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      // 允许在渲染层用 <webview> 内嵌 QQ 空间 / 频道（见 QzoneView / ChannelView）。
      // webview 自身不挂本 preload，远程内容拿不到 tRPC 特权桥。
      webviewTag: true,
    },
  });
  if (entry.title) win.on('page-title-updated', (event) => event.preventDefault());
  win.on('focus', () => {
    lastWindowRuntime = runtime;
  });
  windowLayouts.set(win, layout);
  applyWindowLayout(win, layout, screen.getDisplayMatching(win.getBounds()).workArea);
  windowStyles.set(win, controls);
  updateMainWindowControls(win, layout);

  installWindowChrome(win, () => windowStyles.get(win) ?? 'windows');

  const recovery = createRendererRecovery({
    automatic: true,
    unavailable: () => win.isDestroyed() || win.webContents.isDestroyed(),
    quitting: () => isQuitting,
    showDialog: async () => {
      const result = await dialog.showMessageBox(win, {
        type: 'error',
        title: 'WeQ 界面已停止运行',
        message: '界面进程意外退出，后台进程仍在运行。',
        detail:
          '自动恢复未成功、短时间内再次退出或此类退出需要手动处理。可以重新加载界面或退出 WeQ。未保存的界面内容可能丢失；已提交操作的结果可能尚未显示，请先核对，不要直接重复提交。重新加载不会自动重发操作。',
        buttons: ['重新加载界面', '退出 WeQ', '稍后处理'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      return result.response;
    },
    reload: () => win.webContents.reload(),
    quit: () => {
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
  rendererRecoveries.set(win.webContents.id, recovery);
  win.webContents.on('did-finish-load', () => recovery.loaded());
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) recovery.failed();
  });
  const recoveryId = win.webContents.id;
  win.once(
    'closed',
    runtime.bind(() => {
      toolWindows.clear(recoveryId);
      repairWindowScopes.delete(recoveryId);
      rendererRecoveries.delete(recoveryId);
      recovery.dispose();
      if (!isQuitting && getMainWindow() === win) {
        const cleanup =
          entry === primaryWindow
            ? desktopStartupAccount()
                .wait()
                .then(() => getAppContext().clearAccount(true))
            : disposeAccountWindow(entry);
        void cleanup.catch((error: unknown) =>
          logger.warn('账号窗口退出清理失败', { error: String(error) }),
        );
      }
    }),
  );

  installStartupWindowReveal(win, showInitially);

  // Apply the user-configured close action (设置 → 全局设置 → 关闭按钮):
  //   'quit' → quit the app on every platform;
  //   'tray' → hide to the system tray, keep the process alive;
  //   'ask'  → ask the renderer to show the 关闭确认框 (default, first time).
  win.on(
    'close',
    runtime.bind((e) => {
      if (isQuitting || win !== getMainWindow()) return;
      if (recovery.needsRecovery()) {
        e.preventDefault();
        recovery.request();
        return;
      }
      const behavior = resolveCloseBehavior();
      if (behavior === 'quit') {
        if (hasOtherAccountWindow(runtime)) return;
        e.preventDefault();
        app.quit();
        return;
      }
      e.preventDefault();
      if (behavior === 'tray' && tray) {
        win.hide();
        return;
      }
      // 'ask' — or 'tray' but the tray failed to build → fall back to asking.
      // 有后台服务在跑时一并带上名单：完全退出会让这些服务停止，用户在
      // 「关窗」这个模糊动作上需要知道代价；真正的退出动作（Dock / Cmd+Q /
      // 托盘「退出 WeQ」）不经过这里，直接退出。
      win.webContents.send('window:confirm-close', {
        canMinimizeToTray: Boolean(tray),
        services: backgroundServicesRunning().map((service) => service.label),
      });
    }),
  );

  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (isMessageImageWindow(url, frameName)) return allowMessageImageWindow(win);
    const options = applicationToolPopupOptions(url, frameName);
    if (options) return { action: 'allow', overrideBrowserWindowOptions: options };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on(
    'did-create-window',
    runtime.bind((child, details) => {
      if (isMessageImageWindow(details.url, details.frameName)) {
        registerMessageImageWindow(win, child);
        return;
      }
      const options = applicationToolPopupOptions(details.url, details.frameName);
      if (!options) return;
      labelPerformanceWindow(child, options.title ?? '应用工具窗口');
      const composition = details.frameName === 'weq-compose';
      if (!composition) installWindowControls(child, details.options.frame === false);
      const owner = win.webContents.id;
      toolWindows.register(owner, details.frameName, child);
      if (details.frameName === 'weq-db-repair')
        guardDatabaseMaintenanceWindow(child, {
          quitting: () => isQuitting,
          current: () => {
            const scope = repairWindowScopes.get(owner);
            return scope ? databaseMaintenance.current(scope) : null;
          },
          confirmEnd: async () =>
            (
              await dialog.showMessageBox(child, {
                type: 'question',
                title: '结束数据库维护？',
                message: '此账号的数据库仍在维护中。',
                detail:
                  '放弃本次扫描结果并关闭窗口，将停止检查、释放全部目标数据库的维护锁。历史报告继续保留。',
                buttons: ['继续维护', '放弃并关闭'],
                defaultId: 1,
                cancelId: 0,
                noLink: true,
              })
            ).response === 1,
          end: (snapshot) => databaseMaintenance.end(snapshot),
          failed: (error) => {
            void dialog.showMessageBox(child, {
              type: 'error',
              title: '无法结束数据库维护',
              message: String(error),
            });
          },
        });
      if (composition) compositionWindows.set(owner, child);
      const reportState = () => {
        if (!win.isDestroyed() && !child.isDestroyed())
          win.webContents.send('composition:state', { maximized: child.isMaximized() });
      };
      if (composition) {
        const nativeControls = details.options.frame !== false;
        child.webContents.on('dom-ready', () => {
          void child.webContents
            .executeJavaScript(
              `document.documentElement.toggleAttribute('data-native-window-controls', ${nativeControls})`,
            )
            .catch(() => undefined);
        });
        child.on('maximize', reportState);
        child.on('unmaximize', reportState);
        reportState();
      }
      child.on('closed', () => {
        if (composition && compositionWindows.get(owner) === child)
          compositionWindows.delete(owner);
      });
      child.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
      });
      child.webContents.on('will-navigate', (event, url) => {
        event.preventDefault();
        if (url !== 'about:blank') void shell.openExternal(url);
      });
    }),
  );

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(moduleDir, '../renderer/index.html'));
  }
  return win;
}

// 每个桌面应用只持有一个 Electron 单实例锁，账号窗口共享这一宿主。
const hasSingleInstanceLock = app.requestSingleInstanceLock();
declare const __WEQ_BUILD_REVISION__: { commit: string | null; builtAt: string } | undefined;
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  if (!focusTarget) guardStorageCleanupStartup();
  app.on('second-instance', (_event, argv) => {
    void desktopReady
      .then(async () => {
        if (isQuitting) return;
        const focus = focusAccountTarget(argv);
        if (focus) {
          focusOpenAccount(focus);
          return;
        }
        if (argv.includes(AUTOSTART_ARG)) {
          if (getAppContext().bootstrap?.userConfig.getSettings().showWindowOnAutostart)
            revealLastWindow();
          return;
        }
        if (argv.includes(MANUAL_RESTART_ARG)) {
          revealLastWindow();
          return;
        }
        await openAccountWindow(instanceTarget(argv));
      })
      .catch((error: unknown) => dialog.showErrorBox('无法打开账号窗口', String(error)));
  });
}

const publicDir = app.isPackaged
  ? join(process.resourcesPath, 'remote-web')
  : join(app.getAppPath(), '../web/dist/public');
const developmentUrl = is.dev ? process.env.WEQ_DEV_WEB_URL : undefined;

async function registerDesktopAccount(entry: AccountWindowState): Promise<void> {
  const config = getAppContext().bootstrap?.userConfig;
  if (!config) return;
  const core = new WebCore({
    developmentUrl,
    publicDir,
    exportDir: join(entry.profile, 'web-exports'),
    renderer: electronHost,
    version: app.getVersion(),
    router: appRouter,
    groupVideoSession: (id) => currentGroupCall(id)?.session,
  });
  if (!core.assetsInstalled) return;
  const stop = await registerAccountWorker({
    registry: serviceRegistry,
    core,
    currentAccount: () => {
      const { account, services } = getAppContext();
      const configId = services?.accountConfig.getConfigId();
      return account && configId
        ? { session: account, uin: String(account.context.uin), configId }
        : null;
    },
    watchClosing: (callback) => {
      accountEventBus.on('closing', callback);
      return () => accountEventBus.off('closing', callback);
    },
    launch: async (configId) => {
      await openAccountWindow(savedAccountTarget(defaultDataRoot, configId));
    },
    assignedUin: entry.assignedUin,
    openHere: async (configId) => {
      const target = savedAccountTarget(defaultDataRoot, configId);
      if (entry.assignedUin !== target.uin || getAppContext().account)
        throw new Error('此窗口已打开账号或所属账号已变化。');
      const result = await openStartupAccount(
        config,
        appRouter.createCaller({}).bootstrap,
        process.platform === 'darwin',
        configId,
      );
      if (!result.opened) throw new Error(result.error ?? '请在账号窗口完成登录。');
      openMainWindow();
      getMainWindow()?.webContents.reload();
    },
    reveal: openMainWindow,
  });
  if (isQuitting || entry.closing) stop();
  else entry.stopWorker = stop;
}

async function startDesktop(): Promise<void> {
  if (!hasSingleInstanceLock) return;
  const mode = app.isPackaged ? 'production' : 'development';
  initRuntimeLogging(defaultDataRoot, {
    version: app.getVersion(),
    build: typeof __WEQ_BUILD_REVISION__ === 'undefined' ? undefined : __WEQ_BUILD_REVISION__,
    mode,
    host: 'desktop',
  });
  logger.info('WeQ 启动', {
    event: 'startup',
    version: app.getVersion(),
    mode,
    platform: process.platform,
    arch: process.arch,
  });
  const remoteHelper =
    process.env.WEQ_REMOTE_HELPER ??
    join(
      app.isPackaged ? process.resourcesPath : app.getAppPath(),
      app.isPackaged
        ? `remote-network/weq-remote-network${process.platform === 'win32' ? '.exe' : ''}`
        : '../../tools/remote-network/weq-remote-network',
    );
  if (focusTarget) {
    app.exit(0);
    return;
  }
  try {
    const storage = new DesktopStorage(defaultDataRoot);
    primaryWindow.storage = storage;
    const migrate = !fs.existsSync(accountStorageMigrationPath(defaultDataRoot));
    if (migrate || hasPendingWeqBackupRestore(defaultDataRoot)) {
      storage.initialize(() => {
        if (migrate) migrateAccountStorage(defaultDataRoot);
        initBackupContext(defaultDataRoot, true);
      });
    } else {
      initBackupContext(defaultDataRoot, true);
    }
    setDesktopStorage(storage);
  } catch (error) {
    logger.error('无法打开 WeQ 数据', {
      event: 'startup-storage-failed',
      ...logErrorContext(error),
    });
    dialog.showErrorBox('无法打开 WeQ 数据', String(error));
    app.quit();
    return;
  }
  if (accountTarget) {
    try {
      const record = prepareInstanceAccount(defaultDataRoot, accountTarget);
      primaryWindow.instances.claim(accountTarget.uin);
      primaryWindow.title = `WeQ · ${record.displayName || record.uin}`;
    } catch (error) {
      dialog.showErrorBox('无法打开账号窗口', String(error));
      app.quit();
      return;
    }
  }
  setAccountInstanceScope(primaryWindow.instances);
  const autostart =
    app.isPackaged &&
    isAutostartLaunch(
      process.argv,
      process.platform,
      process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin,
    );
  electronApp.setAppUserModelId('app.weq.desktop');

  // win32: resolve QQ's tencent:// handler (timwp.exe) before building the
  // platform, so install-path detection can anchor on it and skip the fragile
  // registry lookup. linux QQ doesn't register the scheme — skip the probe.
  if (process.platform !== 'linux') {
    await probeQqProtocolHandler();
  }
  if (isQuitting) return;

  // Order matters: AppContext (loads native + platform) before IPC handler.
  // The host bridge must be installed before any router runs.
  setHost(
    developmentProfile
      ? {
          ...electronHost,
          canAutostart: false,
          startupReadOnly: true,
          getAutostart: async () => ({ ...(await electronHost.getAutostart!()), readOnly: true }),
          setAutostart: undefined,
        }
      : electronHost,
  );
  const stopNetwork = installDesktopNetwork((level, host, error) =>
    logger[level](level === 'debug' ? 'GitHub 加速站请求失败' : 'HTTPS 请求失败', {
      scope: 'chromium',
      address: host,
      code: error,
    }),
  );
  app.once('will-quit', stopNetwork);
  accountEventBus.on('closing', () => electronHost.setApplicationBadge?.(0));
  if (!developmentProfile)
    await migrateLegacyAutostart().catch((error: unknown) => {
      logger.warn('legacy daemon migration failed', {
        event: 'legacy-daemon-migration-failed',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  if (isQuitting) return;
  initAppContext(defaultDataRoot, defaultDataRoot);
  void import('./data_saver')
    .then(async ({ refreshTransferPolicy }) => {
      await refreshTransferPolicy();
      getAppContext().bootstrap?.enhancements.updates.start();
    })
    .catch(() => undefined);
  const userConfig = getAppContext().bootstrap?.userConfig;
  if (userConfig) app.once('will-quit', userConfig.watchSharedSettings());
  const updateDataRoot = userConfig?.appDataRoot() ?? app.getPath('userData');
  configureReleaseFeeds(updateDataRoot);
  app.once(
    'will-quit',
    startAnnouncements({
      dataRoot: updateDataRoot,
      sharedDataRoot: defaultDataRoot,
      platform: desktopAnnouncementPlatform(process.platform),
      version: app.getVersion(),
      fetcher: electronAnnouncementFetch,
      bannerEnabled: () =>
        userConfig?.getSettings().notificationEvents.officialAnnouncement.banner ?? true,
    }),
  );
  installUpdateActions({
    dataRoot: updateDataRoot,
    getInterval: () => userConfig?.getSettings().updateCheckIntervalMinutes ?? 60,
    setInterval: (minutes) => {
      if (!userConfig) throw new Error('配置尚未准备好，请稍后重试');
      userConfig.setSettings({ updateCheckIntervalMinutes: minutes });
    },
    get: () => userConfig?.getSettings().updateCheckPrerelease === true,
    set: (enabled) => {
      if (!userConfig) throw new Error('配置尚未准备好，请稍后重试');
      userConfig.setSettings({ updateCheckPrerelease: enabled });
    },
  });
  // 固定本轮启动页，运行中修改偏好留到下次进程启动生效。
  userConfig?.getStartupPage();
  // 旧版安卓备份的 uin 是从资料库猜的，可能猜错；纠正它会连带改 configId，
  // 所以必须在账号打开之前、且在任何按 id 建目录的服务之前跑完。
  if (userConfig && !developmentProfile) {
    await migrateStaticAccountIdentity(requirePlatform(), userConfig).catch((error: unknown) => {
      logger.warn('static account identity migration failed', {
        event: 'static-account-identity-migration-failed',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  if (userConfig?.getSettings().weqAssistant.enabled) {
    void getAppContext()
      .applyWeqAssistant(userConfig.getSettings().weqAssistant)
      .catch((error: unknown) => {
        logger.warn('assistant resource startup failed', {
          event: 'assistant-resource-startup-failed',
          error: String(error),
        });
      });
  }
  if (userConfig && !isQuitting) {
    stopDesktopServices = connectDesktopServices(serviceRegistry, {
      dataRoot: defaultDataRoot,
      config: userConfig,
      publicDir,
      developmentUrl,
      remoteDirectory: join(defaultElectronDataRoot, 'remote-network'),
      remoteHelper,
    });
    void registerDesktopAccount(primaryWindow).catch((error: unknown) =>
      logger.warn('桌面账号服务初始化失败', { error: String(error) }),
    );
    void desktopWebStatus().catch((error: unknown) =>
      logger.warn('桌面服务自动启动失败', { error: String(error) }),
    );
  }
  const logDirectory = getLogDir();
  if (logDirectory) {
    performanceMonitor = installPerformanceMonitor(
      join(logDirectory, '..'),
      createDesktopCollector(
        () => {
          const window = getMainWindow();
          return window && !window.isDestroyed() ? window.webContents.id : undefined;
        },
        performanceDatabaseDetails,
        (kind, reason) => performanceMonitor?.recordEvent(kind, reason),
      ),
    );
    const files = getBackupContext();
    if (files.ok) {
      void finishPerformanceRecordingReset(files.config).catch((error: unknown) =>
        logger.warn('恢复性能记录档位未完成', { error: String(error) }),
      );
      const pending = files.result?.hostPending
        ? files.result
        : weqBackupRestoreStatus(files.root).result;
      if (pending?.hostPending && !developmentProfile)
        void applyRestoredHostPreferences(files.root, pending, true).catch((error: unknown) =>
          logger.warn('应用备份中的本机设置失败', { error: String(error) }),
        );
    }
  }
  // 链接卡片抓不到 og:image 时的兜底封面。截图要跑一个真浏览器，服务层不认识
  // Electron，所以实现在这里注入（app_context 保持 Electron-free，web 端共用它）。
  getAppContext().bootstrap?.linkPreview.setScreenshotHook(screenshotPage);
  // 群关键词命中：弹系统通知（群头像）+ 写 unread 2006 高亮。服务层不认识
  // Electron，所以实现注入在这里（app_context 保持 Electron-free）。
  setGroupKeywordNotifier(handleGroupKeywordHit);
  // 防撤回：拦到新撤回时按会话开关弹系统通知（服务层注入，保持 Electron-free）。
  setRecallNotifier(handleRecallNotification);
  setMailNotifier(handleMailNotification);
  // 意图感知本地引擎（Laya ONNX worker）的宿主控制面。
  setIntentSenseLocalEngine(getIntentSenseLocalEngine());

  bindDesktopWindowSession(primaryWindow, session.defaultSession);
  registerMediaThumbnailIpc();
  registerUdpCaptureStorage();
  registerWindowLayoutIpc();
  registerMediaIpc();
  registerMediaExportIpc();
  registerLogIpc();
  registerRendererRecoveryIpc((sender) =>
    sender === getMainWindow()?.webContents ? rendererRecoveries.get(sender.id) : undefined,
  );
  registerSystemAuthIpc();
  registerTotpIpc();
  // 启动时立即在后台探测 Windows Hello 可用性，避免 UI 首次调用时卡顿。
  systemAuthService.warmup();
  registerCaptureIpc();
  registerMessageImageIpc(writeImageToClipboard);
  registerAnalyticsExportIpc();
  registerChannelIpc();
  registerQzoneIpc();
  registerFlashShareIpc();
  registerWeqAssistantIpc();
  registerAttachHintIpc();
  registerElevationIpc();
  registerLongTermAuthorizationIpc();
  registerEditUndoIpc();
  registerEditContextMenu();
  registerCallVideoIpc(() => getMainWindow()?.webContents);
  const visibleAccountConfigs = () =>
    new Map((userConfig?.listAccountConfigs() ?? []).map((record) => [record.configId, record]));
  const assertAccountMenuSender = (event: Electron.IpcMainInvokeEvent) => {
    if (
      event.sender !== getMainWindow()?.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('账号窗口操作只在 WeQ 主窗口可用。');
  };
  accountIpc.handle('account-instances:list', (event): AccountInstanceInfo[] => {
    assertAccountMenuSender(event);
    const running = new Map<string, boolean>();
    return Array.from(visibleAccountConfigs().values(), (record) => {
      if (!running.has(record.uin))
        running.set(
          record.uin,
          !windowState().instances.owns(record.uin) &&
            accountIsRunning(defaultDataRoot, record.uin),
        );
      const { configId, uin, displayName, avatarUrl, static: isStatic, mobile } = record;
      return {
        configId,
        uin,
        displayName,
        avatarUrl,
        static: isStatic,
        mobile,
        running: running.get(uin) === true,
      };
    });
  });
  accountIpc.handle('account-instances:open', async (event, configId: unknown) => {
    assertAccountMenuSender(event);
    const record = typeof configId === 'string' ? visibleAccountConfigs().get(configId) : undefined;
    if (!record) throw new Error('找不到此账号的已保存数据源。');
    await openAccountWindow(record);
  });
  accountIpc.handle('account-instances:new-window', async (event) => {
    assertAccountMenuSender(event);
    await openAccountWindow();
  });

  app.on('browser-window-created', (_, win) => {
    optimizer.watchWindowShortcuts(win);
    registerWindowUnloadConfirmation(win.webContents, {
      confirmDiscard: () =>
        dialog.showMessageBoxSync(win, {
          type: 'warning',
          title: '存在未保存的更改',
          message: '放弃此窗口中未保存的更改？',
          buttons: ['继续编辑', '放弃更改'],
          defaultId: 1,
          cancelId: 0,
          noLink: true,
        }) === 1,
      cancelled: () => {
        isQuitting = false;
        resetQuitPreparation();
        cancelApplicationRestart();
      },
    });
  });

  mainIpcHandler = createIPCHandler({
    router: appRouter,
    windows: [],
    createContext: async ({ event }) => {
      // electron-trpc 实际使用 ipcMain.on，但类型误声明为 InvokeEvent。
      guardTrpcReply(event as IpcMainEvent);
      return { accountRuntime: accountRuntimeFor(event.sender) };
    },
  });
  buildTray();
  // 开发窗口可使用共享的默认账号，保留主窗口的一次性跳过状态。
  if (pickerId && !app.isPackaged)
    primaryWindow.startupConfigId ??= developmentStartupConfigId(
      defaultDataRoot,
      pickerId,
      userConfig?.getAutoEnter(),
    );
  // 先安排后台任务，以同一启动目标确定窗口尺寸；不等待数据库打开。
  if (
    userConfig &&
    !getAppContext().nativeError &&
    !isQuitting &&
    (!developmentProfile || primaryWindow.startupConfigId)
  )
    void desktopStartupAccount().start(() =>
      openStartupAccount(
        userConfig,
        appRouter.createCaller({}).bootstrap,
        process.platform === 'darwin',
        primaryWindow.startupConfigId,
      ),
    );
  mainWindowLifecycle.open({
    show: shouldShowStartupWindow({
      autostart,
      showWindowOnAutostart: userConfig?.getSettings().showWindowOnAutostart ?? false,
      trayAvailable: tray !== null,
      manualRequested: mainWindowRequested,
    }),
  });
  logger.info('main window created', { event: 'create-window', autostart });
  const locale = app.getPreferredSystemLanguages()[0] ?? app.getLocale();
  const menu =
    process.platform === 'darwin'
      ? macApplicationMenu(
          requestAccountPicker,
          restartFromMenu,
          locale,
          undoFocusedContent,
          redoFocusedContent,
        )
      : desktopApplicationMenu(requestAccountPicker, locale);
  const help =
    process.platform === 'darwin'
      ? undefined
      : Menu.getApplicationMenu()?.items.find((item) => item.role === 'help');
  Menu.setApplicationMenu(Menu.buildFromTemplate(help ? [...menu, help] : menu));

  // Silent background update check (packaged builds only). Result is cached and
  // pushed to the renderer via the `update.onEvent` subscription → settings red
  // dot. Deferred so it never competes with first paint; failures are ignored.
  if (!developmentProfile) startAutomaticUpdateChecks();

  app.on('activate', (_event, hasVisibleWindows) => {
    const mainWindows = [...accountWindows.keys()].map((runtime) => runtime.run(getMainWindow));
    if (shouldRevealMainWindowOnActivation(hasVisibleWindows, mainWindows)) revealLastWindow();
  });

  const developmentWindowPath = process.env.WEQ_DEV_WINDOW_ENDPOINT;
  if (!app.isPackaged && developmentWindowPath && !isQuitting)
    await publishDevelopmentWindow(developmentWindowPath, () => openAccountWindow()).then(
      (close) => app.once('quit', close),
      (error: unknown) =>
        logger.warn('开发启动脚本无法请求新窗口', {
          event: 'dev-window-control',
          ...logErrorContext(error),
        }),
    );
}

const desktopReady = app
  .whenReady()
  .then(startDesktop)
  .catch(async (error: unknown) => {
    logger.error('WeQ 启动失败', { event: 'startup-desktop-failed', ...logErrorContext(error) });
    await flushFileLogger();
    dialog.showErrorBox('WeQ 启动失败', String(error));
    app.quit();
  });

app.on('window-all-closed', () => {
  // With the tray keeping the process alive, closing the window normally hides
  // it (never reaching here). Explicit quit actions call app.quit themselves;
  // macOS can keep running after a window is destroyed and reopen on activation.
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

// A real quit is underway (tray「退出」/ Cmd+Q / Dock 菜单退出 / OS shutdown):
guardDatabaseMaintenanceQuit(app, {
  repairing: () => databaseMaintenance.active().some((snapshot) => snapshot.state === 'repairing'),
  restoring: waitForDatabaseRestore,
  confirmStop: async () => {
    const options = {
      type: 'question' as const,
      title: '停止修复并退出 WeQ？',
      message: '数据库修复正在进行。',
      detail:
        '停止尚未提交的临时重建，不再启动后续数据库；已经修复成功的库保持不变，并保留本轮报告。',
      buttons: ['继续修复', '停止修复并退出'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    };
    const window = getMainWindow();
    return (
      (await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)))
        .response === 1
    );
  },
  stop: () => databaseMaintenance.shutdown(),
  cancelled: () => {
    isQuitting = false;
    resetQuitPreparation();
    cancelApplicationRestart();
  },
  failed: (error) => {
    logger.error('failed to stop database repair on quit', { error: String(error) });
    void dialog.showMessageBox({
      type: 'error',
      title: '停止修复时发生错误',
      message: 'WeQ 暂未退出，请查看修复状态和报告后重试。',
      detail: String(error),
    });
  },
});
autoUpdater.on('before-quit-for-update', cancelApplicationRestart);
// 只放行窗口关闭；未保存内容仍可能取消退出，暂不停止服务或销毁托盘。
// 退出不再弹「确认 / 最小化到托盘」：用户选的就是退出，后台服务随 `will-quit`
// 统一释放，「会停掉哪些服务」的信息在关窗确认框展示。
const resetQuitPreparation = registerAppQuitPreparation(app, autoUpdater, () => {
  isQuitting = true;
});

// 后台服务随应用结束；次实例退出不能关闭主实例拥有的服务。
if (hasSingleInstanceLock) {
  registerAppQuitCleanup(
    app,
    async () => {
      logger.info('app quit cleanup started', { event: 'app-quit-cleanup-start' });
      try {
        await waitForDatabaseRestore();
        const accountCleanup = [...accountWindows.keys()].map((runtime) =>
          runtime.run(async () => {
            const ctx = getAppContext();
            await Promise.all([
              flushConversationCalendarResults(),
              ctx.services?.unreadInfo.dispose(),
              disposeExternalMcp(),
            ]);
          }),
        );
        await Promise.all([
          ...accountCleanup,
          databaseCheckups.cancelAll(),
          databaseMaintenance.shutdown(),
          assistantResourceServer.shutdown(),
          stopDesktopServices?.(),
        ]);
      } finally {
        await flushFileLogger();
      }
    },
    (error) => {
      logger.warn('failed to stop assistant resources on quit', {
        event: 'assistant-resource-quit-failed',
        error: String(error),
      });
    },
    autoUpdater,
  );
}

app.on('quit', () => {
  for (const entry of accountWindows.values()) {
    entry.stopWorker?.();
    entry.storage?.close();
    entry.instances.dispose();
  }
  void stopDesktopServices?.().catch((error: unknown) =>
    logger.warn('桌面服务退出失败', { error: String(error) }),
  );
});

// 账号没有显式关闭时，也释放本轮 Web、Remote、MCP 与提权辅助进程。
app.on('will-quit', (event) => {
  if (event.defaultPrevented) return;
  if (performanceMonitor && !performanceQuitReady) {
    event.preventDefault();
    if (!performanceQuitPending) {
      performanceQuitPending = true;
      void performanceMonitor.dispose().finally(() => {
        performanceQuitReady = true;
        app.quit();
      });
    }
    return;
  }
  void databaseCheckups.cancelAll();
  if (hasSingleInstanceLock) {
    try {
      const ctx = getAppContext();
      ctx.bootstrap?.enhancements.updates.stop();
      if (!developmentProfile) ctx.bootstrap?.userConfig.setSkipAutoEnterOnce(!ctx.account);
    } catch (error) {
      logger.warn('failed to save login exit state', {
        event: 'login-exit-state-failed',
        error: String(error),
      });
    }
  }
  for (const runtime of accountWindows.keys())
    runtime.run(() => {
      try {
        getAppContext().services?.roamingBackfill.dispose();
      } catch (error) {
        logger.warn('failed to save roaming pause on quit', {
          event: 'roaming-quit-checkpoint',
          error: String(error),
        });
      }
    });
  if (tray) {
    try {
      tray.destroy();
    } catch {
      /* ignore */
    }
    tray = null;
  }
  void assistantResourceServer.shutdown();
  void stopMcpServer();
  void disposeExternalMcp();
  // 提权抓包子进程是 root 的 —— 退出时主动送走（子进程那边也会在环回连接断开时
  // 自己收尾，这里只是不让它多活一拍）。
  disposeElevatedCaptures();
  // UDP 抓包用的是同一套提权子进程，但会话表是独立的，得单独收。
  disposeUdpCaptures();
});

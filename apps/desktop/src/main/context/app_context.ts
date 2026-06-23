/**
 * Single source of truth for everything the main process holds in memory.
 *
 * Lifecycle:
 *   - `initAppContext()` runs once after `app.whenReady`.
 *   - Bootstrap services (detect / keys / userConfig / globalConfig) live for
 *     the whole process — they only depend on Platform.
 *   - `account` is mutable: starts null, set when the user confirms a key,
 *     cleared when the user closes the account.
 *
 * Native-load failure is NON-FATAL here: instead of throwing (which would
 * leave the renderer with a blank window), we capture the classified error in
 * `nativeError` and leave the platform-dependent services null. The renderer
 * queries `bootstrap.nativeStatus` first and renders an error dialog — per the
 * spec ("native 过期提示版本过旧；其它安装损坏都显示安装损坏；自实现弹窗").
 *
 * No DI framework. Pulling services through `getAppContext()` (plus the
 * `requireBootstrap()` / `requireGlobalConfig()` guards) is enough.
 */

import { EventEmitter } from 'node:events';
import { loadNativeSafe } from '@weq/native';
import { createWin32Platform, type Platform } from '@weq/platform';
import {
  UserConfigService,
  Win32DetectService,
  Win32KeyService,
  GlobalConfigService,
  AvatarCacheService,
  MsgService,
  RecentContactService,
  UnreadInfoService,
  AccountConfigService,
  AccountMonitorService,
  MediaDownloadService,
  ForwardMsgService,
  GroupInfoService,
  GroupNotifyService,
  ProfileService,
  FileAssistantService,
  FileSearchService,
  EmojiService,
  MsgSearchService,
  OnlineStatusService,
  DbDecryptService,
  DbWatchService,
  createNtMsgDbHook,
  type AccountConfigMetadata,
  type DbWatchHandle,
  type NewMessages,
  type DbChange,
} from '@weq/service';
import { openAccount, type AccountContext, type AccountSession } from '@weq/account';

/**
 * Process-wide bus for nt_msg.db changes, fed by the single `dbWatch` loop
 * below. Two events:
 *   - `'changed'` ({@link DbChange})    — every db change (debounced); drives
 *     the open conversation's seq-window re-query in the renderer.
 *   - `'new'`     ({@link NewMessages}) — only when a rowid-delta found newly
 *     inserted rows; reserved for unread / popup notifications.
 * The account router turns each into a tRPC subscription.
 */
export const dbEventBus = new EventEmitter();

/** Trailing debounce — coalesces a burst of calls into one after `ms` idle. */
function trailingDebounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
}

/** One polling loop for the whole process; we (un)mount the active db on it. */
const dbWatch = new DbWatchService();
/** Handle for the currently-watched account db, if any. */
let dbWatchHandle: DbWatchHandle | null = null;
/** Background login/pid/rkey monitor for the open account, if any. */
let accountMonitor: AccountMonitorService | null = null;

/**
 * Mount the nt_msg.db watcher for `session` (idempotent — no-op if already
 * mounted). The hook fans every change into two bus events: a debounced
 * 'changed' (drives the open-conversation re-query) and 'new' (rowid-delta,
 * for notifications). Gated by the 实时消息 setting via {@link mountDbWatch}'s
 * callers / `applyRealtime`.
 */
function mountDbWatch(session: AccountSession): void {
  if (dbWatchHandle) return;
  const emitChanged = trailingDebounce((file: DbChange) => {
    dbEventBus.emit('changed', file);
  }, 200);
  dbWatchHandle = dbWatch.mount(
    createNtMsgDbHook(session, {
      onDbChanged: emitChanged,
      onNewMessages: (change: NewMessages) => {
        dbEventBus.emit('new', change);
      },
    }),
  );
}

/** Stop watching the current account db, if any. */
function unmountDbWatch(): void {
  dbWatchHandle?.unmount();
  dbWatchHandle = null;
}

export interface BootstrapServices {
  detect: Win32DetectService;
  keys: Win32KeyService;
  userConfig: UserConfigService;
  globalConfig: GlobalConfigService;
  avatarCache: AvatarCacheService;
}

/** Services that are re-created whenever an account session opens. */
export interface AccountServices {
  msgs: MsgService;
  recentContacts: RecentContactService;
  unreadInfo: UnreadInfoService;
  accountConfig: AccountConfigService;
  forwardMsgs: ForwardMsgService;
  groupInfo: GroupInfoService;
  groupNotify: GroupNotifyService;
  profile: ProfileService;
  msgSearch: MsgSearchService;
  onlineStatus: OnlineStatusService;
  /** Locate on-disk media (pic/video/ptt/file) for the media protocol. */
  fileSearch: FileSearchService;
  /** CDN fallback download for media missing on disk (uses live rkeys). */
  mediaDownload: MediaDownloadService;
  /** Search file entries by msgId or name. */
  fileAssistant: FileAssistantService;
  /** Decrypt + cache market-face (store sticker) images. */
  emoji: EmojiService;
  /** Export task manager. */
  exportManager: import('@weq/service').ExportTaskManager;
  /** List and bulk-decrypt encrypted QQ NT databases. */
  dbDecrypt: DbDecryptService;
}

/** Classified native-init failure surfaced to the renderer. */
export interface NativeInitError {
  /** 'expired' → "版本过旧请更新"; 'damaged' → "安装损坏". */
  kind: 'expired' | 'damaged';
  /** Raw status code if recoverable, else null. */
  status: number | null;
  /** Underlying message (diagnostics; not shown verbatim to users). */
  message: string;
}

export interface AppContext {
  /** null when native failed to load — check `nativeError` first. */
  platform: Platform | null;
  /** null when native failed to load. */
  bootstrap: BootstrapServices | null;
  /** Set when the native bundle could not be loaded; null on success. */
  nativeError: NativeInitError | null;
  /** Current account session. `null` until the user confirms a key. */
  account: AccountSession | null;
  /** Services bound to the current account. `null` if no account is open. */
  services: AccountServices | null;
  /** Open (or re-open) an account session. Disposes the previous one first. */
  setAccount(ctx: AccountContext, metadata?: AccountConfigMetadata): Promise<void>;
  /** Drop the current account session, if any. */
  clearAccount(): void;
  /**
   * Mount/unmount the live nt_msg.db watcher for the open account without
   * re-opening it. Called when the user toggles 启用数据库监听 so the change
   * takes effect immediately. No-op when no account is open.
   */
  applyRealtime(enabled: boolean): void;
}

let cached: AppContext | undefined;

export function initAppContext(): AppContext {
  if (cached) return cached;

  const result = loadNativeSafe();

  if (!result.ok) {
    // Degraded context: keep the app alive so the renderer can show a dialog.
    cached = {
      platform: null,
      bootstrap: null,
      nativeError: { kind: result.kind, status: result.status, message: result.message },
      account: null,
      services: null,
      setAccount(): Promise<void> {
        throw new Error('native bundle failed to load — cannot open an account');
      },
      clearAccount(): void {
        /* nothing to clear */
      },
      applyRealtime(): void {
        /* no account to watch */
      },
    };
    return cached;
  }

  const platform = createWin32Platform(result.bundle);
  const userConfig = new UserConfigService(platform);

  const bootstrap: BootstrapServices = {
    detect: new Win32DetectService(platform),
    keys: new Win32KeyService(platform),
    userConfig,
    globalConfig: new GlobalConfigService(platform, userConfig),
    avatarCache: new AvatarCacheService(platform, userConfig),
  };

  const ctx: AppContext = {
    platform,
    bootstrap,
    nativeError: null,
    account: null,
    services: null,
    async setAccount(accountCtx: AccountContext, metadata: AccountConfigMetadata = {}): Promise<void> {
      accountMonitor?.stop();
      accountMonitor = null;
      this.account?.dispose();
      dbWatchHandle?.unmount();
      dbWatchHandle = null;
      const session = await openAccount(platform, accountCtx);
      this.account = session;
      const accountConfig = new AccountConfigService(session, platform.appDataRoot());
      this.services = {
        msgs: new MsgService(session),
        recentContacts: new RecentContactService(session),
        unreadInfo: new UnreadInfoService(session),
        accountConfig,
        forwardMsgs: new ForwardMsgService(session),
        groupInfo: new GroupInfoService(session),
        groupNotify: new GroupNotifyService(session),
        profile: new ProfileService(session),
        msgSearch: new MsgSearchService(session),
        onlineStatus: new OnlineStatusService(session),
        fileSearch: new FileSearchService(session, platform),
        mediaDownload: new MediaDownloadService(
          accountConfig,
          // Honour the custom 缓存路径 override (设置 → 账号信息). Applied at
          // account-open time; changing it takes effect on the next 进入.
          userConfig.cacheDir('media'),
        ),
        fileAssistant: new FileAssistantService(session),
        emoji: new EmojiService(session, platform),
        exportManager: new (await import('@weq/service')).ExportTaskManager(
          new MsgService(session),
          userConfig.cacheDir('export'),
        ),
        dbDecrypt: new DbDecryptService(session, platform),
      };
      // Persist credentials + metadata, keyed by data directory. Must run
      // before the monitor starts so its patches land on an existing record.
      accountConfig.save(metadata);

      // Start the background login/pid monitor for this account. rkey
      // harvesting inside it is gated live by the 媒体补全 master switch, so
      // toggling that setting takes effect on the next poll without a re-open.
      // clientkey harvesting is gated by the autoFetchClientKey setting.
      accountMonitor = new AccountMonitorService(
        session,
        platform,
        accountConfig,
        () => userConfig.getSettings().mediaCompletion.enabled,
        () => userConfig.getSettings().autoFetchClientKey,
      );
      accountMonitor.start();

      // Watch this account's nt_msg.db only when 实时消息 is enabled. Toggling
      // it later is handled live by `applyRealtime` (no re-open needed).
      if (userConfig.getSettings().realtimeEnabled) {
        mountDbWatch(session);
      }
    },
    clearAccount(): void {
      accountMonitor?.stop();
      accountMonitor = null;
      unmountDbWatch();
      this.account?.dispose();
      this.account = null;
      this.services = null;
    },
    applyRealtime(enabled: boolean): void {
      const session = this.account;
      if (!session) return;
      if (enabled) mountDbWatch(session);
      else unmountDbWatch();
    },
  };

  cached = ctx;
  return ctx;
}

/**
 * Accessor used by tRPC handlers / IPC. Throws if called before
 * `initAppContext()` — which would be a startup-ordering bug.
 */
export function getAppContext(): AppContext {
  if (!cached) {
    throw new Error('AppContext not initialized — call initAppContext() in main first.');
  }
  return cached;
}

/** Bootstrap services, asserting native loaded. Throws a friendly error otherwise. */
export function requireBootstrap(): BootstrapServices {
  const ctx = getAppContext();
  if (!ctx.bootstrap) {
    throw new Error('Native bundle unavailable — QQ helper failed to initialize.');
  }
  return ctx.bootstrap;
}

/** Platform handle, asserting native loaded. */
export function requirePlatform(): Platform {
  const ctx = getAppContext();
  if (!ctx.platform) {
    throw new Error('Native bundle unavailable — QQ helper failed to initialize.');
  }
  return ctx.platform;
}

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
  AccountConfigService,
  GroupInfoService,
  ProfileService,
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
  accountConfig: AccountConfigService;
  groupInfo: GroupInfoService;
  profile: ProfileService;
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
      this.account?.dispose();
      dbWatchHandle?.unmount();
      dbWatchHandle = null;
      const session = await openAccount(platform, accountCtx);
      this.account = session;
      const accountConfig = new AccountConfigService(session, platform.appDataRoot());
      this.services = {
        msgs: new MsgService(session),
        recentContacts: new RecentContactService(session),
        accountConfig,
        groupInfo: new GroupInfoService(session),
        profile: new ProfileService(session),
      };
      // Persist credentials + metadata, keyed by data directory.
      accountConfig.save(metadata);

      // Watch this account's nt_msg.db. The hook fans every change into two
      // bus events: a debounced 'changed' (drives the open-conversation
      // re-query) and 'new' (rowid-delta, for notifications).
      console.log(`[DbWatch] mount nt_msg.db watcher: ${session.msgDbPath}`);
      const emitChanged = trailingDebounce((file: DbChange) => {
        dbEventBus.emit('changed', file);
      }, 200);
      dbWatchHandle = dbWatch.mount(
        createNtMsgDbHook(session, {
          onDbChanged: emitChanged,
          onNewMessages: (change: NewMessages) => {
            console.log(
              `[DbWatch] new rows → c2c=${change.c2c.length} group=${change.group.length} ` +
                `(listeners=${dbEventBus.listenerCount('new')})`,
            );
            dbEventBus.emit('new', change);
          },
        }),
      );
    },
    clearAccount(): void {
      if (dbWatchHandle) console.log('[DbWatch] unmount nt_msg.db watcher');
      dbWatchHandle?.unmount();
      dbWatchHandle = null;
      this.account?.dispose();
      this.account = null;
      this.services = null;
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

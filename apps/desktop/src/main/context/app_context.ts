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

import { loadNativeSafe } from '@weq/native';
import { createWin32Platform, type Platform } from '@weq/platform';
import {
  UserConfigService,
  Win32DetectService,
  Win32KeyService,
  GlobalConfigService,
  MsgService,
  RecentContactService,
  AccountConfigService,
  GroupInfoService,
  ProfileService,
  type AccountConfigMetadata,
} from '@weq/service';
import { openAccount, type AccountContext, type AccountSession } from '@weq/account';

export interface BootstrapServices {
  detect: Win32DetectService;
  keys: Win32KeyService;
  userConfig: UserConfigService;
  globalConfig: GlobalConfigService;
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
  setAccount(ctx: AccountContext, metadata?: AccountConfigMetadata): void;
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
      setAccount(): void {
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
  };

  const ctx: AppContext = {
    platform,
    bootstrap,
    nativeError: null,
    account: null,
    services: null,
    setAccount(accountCtx: AccountContext, metadata: AccountConfigMetadata = {}): void {
      this.account?.dispose();
      const session = openAccount(platform, accountCtx);
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
    },
    clearAccount(): void {
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

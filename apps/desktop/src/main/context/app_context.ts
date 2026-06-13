/**
 * Single source of truth for everything the main process holds in memory.
 *
 * Lifecycle:
 *   - `initAppContext()` runs once after `app.whenReady`.
 *   - Bootstrap services (detect / keys / userConfig) live for the whole
 *     process — they only depend on Platform.
 *   - `account` is mutable: starts null, set when the user confirms a key,
 *     cleared on app exit (the user manually "closes" the account if they
 *     want to swap — Q3 said "no account switch in v0", so we just don't
 *     wire a UI for swap yet).
 *
 * No DI framework. Pulling services through `getAppContext()` is enough
 * for this codebase's size — the alternative (constructor-pass every
 * tRPC handler) buys nothing.
 */

import { loadNative } from '@weq/native';
import { createWin32Platform, type Platform } from '@weq/platform';
import {
  UserConfigService,
  Win32DetectService,
  Win32KeyService,
  MsgService,
  RecentContactService,
} from '@weq/service';
import { openAccount, type AccountContext, type AccountSession } from '@weq/account';

export interface BootstrapServices {
  detect: Win32DetectService;
  keys: Win32KeyService;
  userConfig: UserConfigService;
}

/** Services that are re-created whenever an account session opens. */
export interface AccountServices {
  msgs: MsgService;
  recentContacts: RecentContactService;
}

export interface AppContext {
  platform: Platform;
  bootstrap: BootstrapServices;
  /** Current account session. `null` until the user confirms a key. */
  account: AccountSession | null;
  /** Services bound to the current account. `null` if no account is open. */
  services: AccountServices | null;
  /** Open (or re-open) an account session. Disposes the previous one first. */
  setAccount(ctx: AccountContext): void;
  /** Drop the current account session, if any. */
  clearAccount(): void;
}

let cached: AppContext | undefined;

export function initAppContext(): AppContext {
  if (cached) return cached;

  const platform = createWin32Platform(loadNative());

  const bootstrap: BootstrapServices = {
    detect: new Win32DetectService(platform),
    keys: new Win32KeyService(platform),
    userConfig: new UserConfigService(platform),
  };

  const ctx: AppContext = {
    platform,
    bootstrap,
    account: null,
    services: null,
    setAccount(accountCtx: AccountContext): void {
      this.account?.dispose();
      const session = openAccount(platform, accountCtx);
      this.account = session;
      this.services = {
        msgs: new MsgService(session),
        recentContacts: new RecentContactService(session),
      };
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
 * `initAppContext()` — which would be a startup-ordering bug, not a
 * recoverable runtime error.
 */
export function getAppContext(): AppContext {
  if (!cached) {
    throw new Error('AppContext not initialized — call initAppContext() in main first.');
  }
  return cached;
}

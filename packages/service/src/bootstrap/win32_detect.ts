/**
 * Detection service — answers "what QQ accounts / processes / files does this
 * machine have?". Reads-only; performs no writes, attachment, or network
 * calls.
 *
 * Accounts come from `login.db` only. There is **no fallback**: when the
 * decrypt fails (missing/rotated key, corrupted DB) the list is empty and the
 * caller surfaces that, instead of the old "launch QQ to enumerate its own
 * login list" detour.
 *
 * One service instance is fine for the whole app lifetime — it's stateless
 * past the constructor.
 */

import { existsSync } from 'node:fs';
import type { Platform } from '@weq/platform';
import type { LoginAccount } from '@weq/native';
import { getLogger } from '../common/logger';
import { readLoginAccounts } from './login_db';

export interface QqInstallInfo {
  qqExePath: string | null;
  wrapperNodePath: string | null;
  /**
   * Tencent Files roots that actually exist on disk. Platform's
   * `tencentFilesRoots()` returns three CANDIDATE locations (used for
   * error messages), but the diagnostics screen only wants the ones
   * the user actually has.
   */
  tencentFilesRoots: string[];
  loginDbPath: string | null;
}

const INSTALL_CACHE_TTL_MS = 5 * 60_000;
const ACCOUNT_CACHE_TTL_MS = 5 * 60_000;

export class Win32DetectService {
  private installCache: { readonly expiresAt: number; readonly value: QqInstallInfo } | null = null;
  private accountCache: { readonly expiresAt: number; readonly value: LoginAccount[] } | null =
    null;

  private readonly logger = getLogger().child({ scope: 'win32-detect' });

  constructor(private readonly platform: Platform) {}

  /** Aggregate the static install / data paths the UI's "diagnostics" screen wants. */
  describeInstall(): QqInstallInfo {
    const now = Date.now();
    if (this.installCache && this.installCache.expiresAt > now) {
      return this.installCache.value;
    }

    const value = {
      qqExePath: this.platform.qqExePath(),
      wrapperNodePath: this.platform.qqWrapperNodePath(),
      tencentFilesRoots: this.platform.tencentFilesRoots().filter((p) => existsSync(p)),
      loginDbPath: this.platform.loginDbPath(),
    };
    this.installCache = {
      expiresAt: now + INSTALL_CACHE_TTL_MS,
      value,
    };
    return value;
  }

  /**
   * All historically-cached accounts from `login.db`. Decrypting is the only
   * source — a failure returns `[]`.
   */
  async listAccounts(): Promise<LoginAccount[]> {
    const now = Date.now();
    if (this.accountCache && this.accountCache.expiresAt > now) {
      return this.accountCache.value;
    }

    const value = await readLoginAccounts(this.platform);
    // Don't cache an empty result: a transient decrypt hiccup shouldn't pin
    // "no accounts" for the whole TTL. Successful results are cached.
    if (value.length > 0) {
      this.accountCache = { expiresAt: now + ACCOUNT_CACHE_TTL_MS, value };
    }
    return value;
  }

  /** Convenience: per-account `nt_msg.db` lookup with a clean error. */
  ntMsgDbPath(uin: string): string {
    const path = this.platform.ntMsgDbPath(uin);
    if (!path) {
      this.logger.warn('nt_msg.db not found for account', { event: 'nt-msg-db-missing', uin });
      throw new Error(`nt_msg.db not found for uin=${uin}`);
    }
    return path;
  }
}

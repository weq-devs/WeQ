/**
 * Win32 detection service — answers "what QQ accounts / processes / files
 * does this machine have?". Reads-only; performs no writes, injection, or
 * network calls.
 *
 * Composed from:
 *   - `Platform` (path resolution, native bundle)
 *   - `nt_helper`'s `decryptLoginDb` (login.db parser)
 *   - `nt_helper`'s `getQqProcesses` + `probeQqLoginInfo` (live QQ probe)
 *
 * One service instance is fine for the whole app lifetime — it's stateless
 * past the constructor.
 */

import { existsSync } from 'node:fs';
import type { Platform } from '@weq/platform';
import type { LoginAccount, QqPortLoginInfo } from '@weq/native';

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

export interface DetectedQqProcess {
  pid: number;
  loginInfo: QqPortLoginInfo | null;
}

const INSTALL_CACHE_TTL_MS = 5 * 60_000;
const ACCOUNT_CACHE_TTL_MS = 5 * 60_000;
const PROCESS_DETECT_CACHE_TTL_MS = 5 * 60_000;

export class Win32DetectService {
  private installCache:
    | { readonly expiresAt: number; readonly value: QqInstallInfo }
    | null = null;
  private accountCache:
    | { readonly expiresAt: number; readonly value: LoginAccount[] }
    | null = null;
  private processCache:
    | { readonly expiresAt: number; readonly value: DetectedQqProcess[] }
    | null = null;

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

  /** All historically-cached accounts from `login.db`. Throws if the DB is missing. */
  listAccounts(): LoginAccount[] {
    const now = Date.now();
    if (this.accountCache && this.accountCache.expiresAt > now) {
      return this.accountCache.value;
    }

    const dbPath = this.platform.loginDbPath();
    if (!dbPath) {
      throw new Error(
        'login.db not found in any candidate Tencent Files root. Is QQ NT installed?',
      );
    }
    const value = this.platform.native.ntHelper.decryptLoginDb(dbPath);
    this.accountCache = {
      expiresAt: now + ACCOUNT_CACHE_TTL_MS,
      value,
    };
    return value;
  }

  /**
   * Walk every running QQ.exe process and probe its local port for login
   * state. Useful for "you have N logged-in QQ windows — which account do
   * you want to pull a key from?".
   */
  detectRunningProcesses(): DetectedQqProcess[] {
    const now = Date.now();
    if (this.processCache && this.processCache.expiresAt > now) {
      return this.processCache.value;
    }

    const pids = this.platform.native.ntHelper.getQqProcesses();
    const value = pids.map((pid) => ({
      pid,
      loginInfo: this.platform.native.ntHelper.probeQqLoginInfo(pid),
    }));
    this.processCache = {
      expiresAt: now + PROCESS_DETECT_CACHE_TTL_MS,
      value,
    };
    return value;
  }

  /** Convenience: per-account `nt_msg.db` lookup with a clean error. */
  ntMsgDbPath(uin: string): string {
    const path = this.platform.ntMsgDbPath(uin);
    if (!path) {
      throw new Error(`nt_msg.db not found for uin=${uin}`);
    }
    return path;
  }
}

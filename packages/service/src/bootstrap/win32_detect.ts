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

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import { linuxFindLoginDbs } from '@weq/platform';
import {
  NineBirdBootstrap,
  type LoginAccount,
  type NineBirdAccountListItem,
  type QqPortLoginInfo,
  type StubHooks,
} from '@weq/native';
import { getLogger, logErrorContext } from '../common/logger';

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

/**
 * Placeholder written into the synthetic `LoginAccount.a1Key` of fallback
 * accounts that QQ reports as quick-login-able. We can't recover the real
 * A1 token without decrypting login.db (the very thing that just failed),
 * but the UI only treats `a1Key !== ''` as "offer quick login", and the
 * quick-login flow keys off `uin` alone — so a non-empty marker is enough
 * to bucket these correctly. Never sent anywhere as a credential.
 */
const FALLBACK_QUICK_A1 = 'ninebird:quick-login';

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

  private readonly bootstrap: NineBirdBootstrap;
  private readonly logger = getLogger().child({ scope: 'win32-detect' });

  constructor(
    private readonly platform: Platform,
    /** Linux-only entry-stub hooks (pkexec elevation). Omit for the fs default. */
    stubHooks?: StubHooks,
  ) {
    this.bootstrap = new NineBirdBootstrap(
      platform.native.nineBirdBoot,
      platform.native.resources,
      stubHooks,
    );
  }

  /**
   * All login.db paths to decrypt, in merge-priority order. win32 has a single
   * `nt_qq/global/nt_db/login.db`; linux has two (`global/nt_db` primary +
   * `nt_qq/global/nt_db` supplementary), so we consult the linux-specific
   * two-location finder there and dedupe against the platform's own pick.
   */
  private loginDbPaths(): string[] {
    if (this.platform.kind === 'linux') {
      const override = this.platform.tencentFilesRoots()[0] ?? null;
      const both = linuxFindLoginDbs(undefined, override);
      if (both.length > 0) return [...new Set(both)];
    }
    const single = this.platform.loginDbPath();
    return single ? [single] : [];
  }

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
   * All historically-cached accounts from `login.db`.
   *
   * Primary path: decrypt `login.db` directly via `nt_helper`. When that's
   * unavailable (DB missing) or fails (wrong/rotated key, corrupted DB), we
   * transparently fall back to {@link listAccountsFallback} — launching QQ
   * to read its own login list and probing the Tencent Files directory —
   * so the picker still has something to show. Returns `[]` only when even
   * the fallback turns up nothing.
   */
  async listAccounts(): Promise<LoginAccount[]> {
    const now = Date.now();
    if (this.accountCache && this.accountCache.expiresAt > now) {
      return this.accountCache.value;
    }

    // login.db lives in one place on win32 but TWO on linux (`global/nt_db`
    // primary + `nt_qq/global/nt_db` supplementary). Decrypt each and merge,
    // letting earlier (higher-priority) entries win on a uin clash.
    const dbPaths = this.loginDbPaths();
    if (dbPaths.length > 0) {
      const merged = new Map<string, LoginAccount>();
      let anyDecrypted = false;
      for (const dbPath of dbPaths) {
        try {
          const probe = await this.platform.native.ntHelper.testDatabaseKey(dbPath, 'BD156D6710D54D8782F4');
          if (probe.success && probe.pageHmacAlgorithm && probe.kdfHmacAlgorithm) {
            anyDecrypted = true;
            const rows = this.platform.native.ntHelper.decryptLoginDb(dbPath, {
              pageHmacAlgorithm: probe.pageHmacAlgorithm,
              kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
            });
            for (const row of rows) {
              if (row.uin && !merged.has(row.uin)) merged.set(row.uin, row);
            }
          } else {
            this.logger.warn('login.db probe did not yield algorithms', {
              event: 'login-db-probe-unsuccessful',
              dbPath,
              probeSuccess: probe.success,
            });
          }
        } catch (error) {
          this.logger.warn('login.db decrypt threw', {
            event: 'login-db-decrypt-failed',
            dbPath,
            ...logErrorContext(error),
          });
        }
      }
      if (anyDecrypted && merged.size > 0) {
        const value = [...merged.values()];
        this.accountCache = { expiresAt: now + ACCOUNT_CACHE_TTL_MS, value };
        return value;
      }
    } else {
      // No login.db found under any candidate/override root: decryption can't
      // even be attempted — this is the silent case that looks like "nothing
      // happened". Log the roots tried so a misconfigured data dir is obvious.
      this.logger.warn('login.db not found; skipping decrypt, using fallback', {
        event: 'login-db-not-found',
        rootsTried: this.platform.tencentFilesRoots(),
      });
    }

    const value = await this.listAccountsFallback();
    // Don't cache an empty fallback: a transient QQ-launch hiccup shouldn't
    // pin "no accounts" for the whole TTL. Successful results are cached.
    if (value.length > 0) {
      this.accountCache = {
        expiresAt: now + ACCOUNT_CACHE_TTL_MS,
        value,
      };
    }
    return value;
  }

  /**
   * Fallback used when `login.db` can't be decrypted. Two independent
   * sources, merged by uin:
   *
   *   1. `ninebird` account-list — launches QQ, which enumerates its own
   *      login list (nickname, avatar, and the live `isQuickLogin` flag).
   *      These accounts can be quick-logged-in without a QR scan.
   *   2. Directory probe — every `<TencentFilesRoot>/<uin>/nt_qq` dir on
   *      disk. Catches accounts QQ won't quick-login (only `uin` is known;
   *      the UI resolves an avatar from the uin and offers QR login).
   *
   * Account-list entries win on conflict (they carry richer data).
   */
  async listAccountsFallback(): Promise<LoginAccount[]> {
    const [listItems, dirUins] = await Promise.all([
      this.runNinebirdAccountList().catch(() => [] as NineBirdAccountListItem[]),
      Promise.resolve(this.probeAccountDirs()),
    ]);

    const byUin = new Map<string, LoginAccount>();

    // Dir-probed accounts first: QR-only baseline (empty a1Key).
    for (const uin of dirUins) {
      byUin.set(uin, {
        uin,
        uid: '',
        avatarUrl: '',
        userName: '',
        a1Key: '',
        lastLoginAt: 0,
      });
    }

    // Overlay account-list entries — richer data + quick-login marker.
    for (const item of listItems) {
      if (!item.uin) continue;
      byUin.set(item.uin, {
        uin: item.uin,
        uid: item.uid ?? '',
        avatarUrl: item.faceUrl ?? '',
        userName: item.nickName ?? '',
        a1Key: item.isQuickLogin ? FALLBACK_QUICK_A1 : '',
        lastLoginAt: 0,
      });
    }

    return [...byUin.values()];
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

  // ---- fallback helpers (login.db decrypt failure path) ----

  /**
   * Launch QQ with the account-list bootstrap and resolve with whatever
   * login list it reports. Resolves `[]` (never rejects) when QQ.exe isn't
   * found or the flow times out without emitting a list — the caller treats
   * this source as best-effort.
   */
  private runNinebirdAccountList(
    timeoutMs = 60_000,
  ): Promise<NineBirdAccountListItem[]> {
    const exe = this.platform.qqExePath();
    if (!exe) return Promise.resolve([]);

    const session = this.bootstrap.startAccountList({
      qqExePath: exe,
      timeoutMs,
    });
    return new Promise((resolve) => {
      let items: NineBirdAccountListItem[] = [];
      session.onAccountList((e) => {
        items = e.list;
      });
      // The session self-kills on its terminal `result` event (and on
      // timeout). We hand back whatever list arrived, success or not.
      void session.result.then(() => resolve(items));
    });
  }

  /**
   * Every QQ account directory on disk: `<TencentFilesRoot>/<uin>/nt_qq`.
   * Only all-digit directory names that actually contain an `nt_qq` subdir
   * count — this skips siblings like `nt_qq`, `NapCat`, `All Users1`.
   */
  private probeAccountDirs(): string[] {
    const uins = new Set<string>();
    for (const root of this.platform.tencentFilesRoots()) {
      let entries: string[];
      try {
        entries = readdirSync(root);
      } catch {
        continue; // root doesn't exist / unreadable
      }
      for (const name of entries) {
        if (!/^\d+$/.test(name)) continue;
        if (existsSync(join(root, name, 'nt_qq'))) {
          uins.add(name);
        }
      }
    }
    return [...uins];
  }
}

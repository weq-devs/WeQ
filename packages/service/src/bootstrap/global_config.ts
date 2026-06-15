/**
 * GlobalConfigService — app-wide QQ install + runtime facts, cached.
 *
 * The bootstrap UI needs the same handful of paths on every launch (QQ.exe,
 * wrapper.node, login.db, the Tencent Files root, the client version, the
 * user-data path). Probing them touches the registry and the filesystem, so
 * we cache the result in `config.json` (via {@link UserConfigService}) and on
 * subsequent launches:
 *
 *   1. read the cached `install` block,
 *   2. re-validate each path still exists,
 *   3. re-probe + persist only if something went stale.
 *
 * It also owns the live-ish facts the home screen shows: the online-instance
 * probe (with the single-process `isQqLoggedIn` refinement), per-account
 * database sizes for the charts, and the user-data directory count.
 *
 * Storage backend is {@link UserConfigService}; this service holds NO state
 * of its own beyond an in-memory copy of the validated install info.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import type { UserConfigService, InstallCache } from './user_config';

/** Enriched install info the renderer renders + drives error dialogs from. */
export interface GlobalInstallInfo {
  qqExePath: string | null;
  wrapperNodePath: string | null;
  loginDbPath: string | null;
  /** Effective Tencent Files root (user override wins over detection). */
  tencentFilesRoot: string | null;
  /** QQ client version parsed from the wrapper.node path, e.g. `9.9.28-46928`. */
  version: string | null;
  /** Same value as `tencentFilesRoot`, exposed under the spec's name. */
  userDataPath: string | null;
  // Convenience health flags for the renderer's dialog logic:
  hasQqExe: boolean;
  hasWrapper: boolean;
  hasUserData: boolean;
  hasLoginDb: boolean;
}

/** Result of an online-instance probe. */
export interface OnlineProbe {
  /** Number of online QQ instances (main pids). */
  count: number;
  /**
   * Per-uin login state — populated only when exactly one QQ process is
   * running (the spec's mutex-lock refinement), else null.
   */
  byUin: Record<string, boolean> | null;
}

/** One database file's on-disk size (for the language-bar chart). */
export interface DbFileStat {
  name: string;
  path: string;
  bytes: number;
}

/** One nt_data subdirectory's recursive size (for the space chart). */
export interface DirSize {
  name: string;
  bytes: number;
}

const INSTALL_CACHE_TTL_MS = 24 * 60 * 60_000; // a day; path validation gates correctness anyway

export class GlobalConfigService {
  private memo: GlobalInstallInfo | null = null;

  constructor(
    private readonly platform: Platform,
    private readonly userConfig: UserConfigService,
  ) {}

  // ---- install info (cache → validate → reprobe) ----

  /**
   * Resolve the install info, preferring the persisted cache. Each cached
   * path is re-validated; if any required path is missing or the cache is
   * older than the TTL we re-probe and persist. Pass `force` to skip the
   * cache entirely (used after the user changes the data-dir override).
   */
  describeInstall(force = false): GlobalInstallInfo {
    if (!force && this.memo) return this.memo;

    if (!force) {
      const cached = this.userConfig.read().install;
      if (cached && this.cacheStillValid(cached)) {
        this.memo = this.toInfo(cached);
        return this.memo;
      }
    }

    const fresh = this.probe();
    this.userConfig.write({ install: fresh });
    this.memo = this.toInfo(fresh);
    return this.memo;
  }

  /** Force a fresh probe + persist (e.g. after the data-dir override changes). */
  refresh(): GlobalInstallInfo {
    return this.describeInstall(true);
  }

  /** Persist a user-picked Tencent Files root and re-probe everything. */
  setTencentFilesRootOverride(root: string | null): GlobalInstallInfo {
    this.userConfig.write({ tencentFilesRootOverride: root });
    return this.refresh();
  }

  private cacheStillValid(cache: InstallCache): boolean {
    if (Date.now() - cache.probedAt > INSTALL_CACHE_TTL_MS) return false;
    // A path that was present but has since vanished invalidates the cache.
    if (cache.qqExePath && !existsSync(cache.qqExePath)) return false;
    if (cache.wrapperNodePath && !existsSync(cache.wrapperNodePath)) return false;
    if (cache.loginDbPath && !existsSync(cache.loginDbPath)) return false;
    if (cache.tencentFilesRoot && !existsSync(cache.tencentFilesRoot)) return false;
    // If the override changed since the cache was written, re-probe.
    const override = this.userConfig.read().tencentFilesRootOverride ?? null;
    if ((override ?? null) !== (cache.tencentFilesRoot ?? null) && override) return false;
    return true;
  }

  private probe(): InstallCache {
    const qqExePath = this.platform.qqExePath();
    const wrapperNodePath = this.platform.qqWrapperNodePath();
    const override = this.userConfig.read().tencentFilesRootOverride ?? null;
    const detectedRoot = this.platform.tencentFilesRoots().find((p) => existsSync(p)) ?? null;
    const tencentFilesRoot = (override && existsSync(override)) ? override : detectedRoot;
    return {
      qqExePath,
      wrapperNodePath,
      loginDbPath: this.platform.loginDbPath(),
      tencentFilesRoot,
      version: parseQqVersion(wrapperNodePath),
      userDataPath: tencentFilesRoot,
      probedAt: Date.now(),
    };
  }

  private toInfo(cache: InstallCache): GlobalInstallInfo {
    return {
      qqExePath: cache.qqExePath,
      wrapperNodePath: cache.wrapperNodePath,
      loginDbPath: cache.loginDbPath,
      tencentFilesRoot: cache.tencentFilesRoot,
      version: cache.version,
      userDataPath: cache.userDataPath,
      hasQqExe: !!cache.qqExePath && existsSync(cache.qqExePath),
      hasWrapper: !!cache.wrapperNodePath && existsSync(cache.wrapperNodePath),
      hasUserData: !!cache.tencentFilesRoot && existsSync(cache.tencentFilesRoot),
      hasLoginDb: !!cache.loginDbPath && existsSync(cache.loginDbPath),
    };
  }

  // ---- account data dir helpers (primary key) ----

  /** `<tencentFilesRoot>/<uin>` — the account's user-data directory, or null. */
  accountDataDir(uin: string): string | null {
    const root = this.describeInstall().tencentFilesRoot;
    if (!root) return null;
    const dir = join(root, uin);
    return existsSync(dir) ? dir : null;
  }

  /**
   * Number of user-data directories under the Tencent Files root: all-digit
   * subdir names that contain an `nt_qq` folder.
   */
  countUserDataDirs(): number {
    const root = this.describeInstall().tencentFilesRoot;
    if (!root) return 0;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return 0;
    }
    let count = 0;
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      if (existsSync(join(root, name, 'nt_qq'))) count++;
    }
    return count;
  }

  // ---- online-instance probe ----

  /**
   * Probe how many QQ instances are online. When exactly one QQ process is
   * running, port-probing can't always attribute it to an account, so we fall
   * back to the per-uin mutex-lock probe (`isQqLoggedIn`) over the known uins
   * — and surface the per-uin map so the caller can dispatch key acquisition.
   *
   * `isQqLoggedIn` failing (older native without it) degrades gracefully to
   * `byUin: null`; the caller then uses the legacy port-probe path.
   */
  probeOnline(knownUins: string[] = []): OnlineProbe {
    const nt = this.platform.native.ntHelper;
    let pids: number[];
    try {
      pids = nt.getQqProcesses();
    } catch {
      pids = [];
    }

    if (pids.length === 1 && knownUins.length > 0) {
      try {
        const byUin: Record<string, boolean> = {};
        let online = 0;
        for (const uin of knownUins) {
          const ok = nt.isQqLoggedIn(uin);
          byUin[uin] = ok;
          if (ok) online++;
        }
        // At least the one running process is online even if the mutex probe
        // attributed nothing — never under-report below the pid count.
        return { count: Math.max(online, pids.length), byUin };
      } catch {
        // isQqLoggedIn unavailable / threw — fall through to pid count.
      }
    }

    return { count: pids.length, byUin: null };
  }

  // ---- database size stats (charts) ----

  /**
   * Largest `*.db` files for an account, newest-first by size, capped at
   * `topN`. Scans the `nt_db` folder (where the encrypted databases live).
   */
  dbFileSizes(uin: string, topN = 8): DbFileStat[] {
    const dataDir = this.accountDataDir(uin);
    if (!dataDir) return [];
    const ntDb = join(dataDir, 'nt_qq', 'nt_db');
    let entries: string[];
    try {
      entries = readdirSync(ntDb);
    } catch {
      return [];
    }
    const files: DbFileStat[] = [];
    for (const name of entries) {
      if (!name.endsWith('.db')) continue;
      const path = join(ntDb, name);
      try {
        const st = statSync(path);
        if (st.isFile()) files.push({ name, path, bytes: st.size });
      } catch {
        /* skip unreadable */
      }
    }
    files.sort((a, b) => b.bytes - a.bytes);
    return files.slice(0, topN);
  }

  /**
   * Recursive sizes of each immediate subdirectory under
   * `<dataDir>/nt_qq/nt_data`. Can be slow on accounts with many small files
   * (caller should show a placeholder); bounded by a node-count guard.
   */
  ntDataSubdirSizes(uin: string): DirSize[] {
    const dataDir = this.accountDataDir(uin);
    if (!dataDir) return [];
    const ntData = join(dataDir, 'nt_qq', 'nt_data');
    let entries: string[];
    try {
      entries = readdirSync(ntData, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? [d.name] : [],
      );
    } catch {
      return [];
    }
    const sizes: DirSize[] = entries.map((name) => ({
      name,
      bytes: dirSize(join(ntData, name)),
    }));
    sizes.sort((a, b) => b.bytes - a.bytes);
    return sizes;
  }

  /**
   * Recursive total size of the account's user-data directory
   * (`<tencentFilesRoot>/<uin>`), in bytes. Bounded by `dirSize`'s node cap.
   */
  accountDirSize(uin: string): number {
    const dataDir = this.accountDataDir(uin);
    if (!dataDir) return 0;
    return dirSize(dataDir, 2_000_000);
  }
}

/** Parse the QQ version segment out of a `…\versions\<ver>\resources\…` path. */
export function parseQqVersion(wrapperNodePath: string | null): string | null {
  if (!wrapperNodePath) return null;
  const match = wrapperNodePath.match(/[\\/]versions[\\/]([^\\/]+)[\\/]/i);
  return match ? (match[1] ?? null) : null;
}



/**
 * Recursive directory size with a hard node-visit cap so a pathological tree
 * (QQ caches can hold hundreds of thousands of tiny files) can't wedge the
 * main process. Returns the summed byte size of files visited.
 */
function dirSize(root: string, cap = 200_000): number {
  let total = 0;
  let visited = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (++visited > cap) return total;
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        stack.push(full);
      } else if (d.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* skip */
        }
      }
    }
  }
  return total;
}

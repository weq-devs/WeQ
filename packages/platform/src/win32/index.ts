/**
 * Win32 Platform implementation. Composes the pure path helpers + registry
 * lookup + native bundle into one object.
 *
 * `createWin32Platform` deliberately takes the native bundle as a
 * constructor argument — it does NOT call `loadNative()` itself. This
 * keeps Platform testable: pass a stub native bundle in unit tests, the
 * real bundle in production.
 */

import type { NativeBundle, NtHelperBinding } from '@weq/native';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Platform } from '../types';
import { readLauncherCount, readQqVersion } from '../qq_meta';
import {
  candidateTencentFilesRoots,
  findAccountDir,
  findBuddyMsgFtsDb,
  findGroupMsgFtsDb,
  findEmojiResourceDir,
  findLoginDb,
  findNtDbDir,
  findNtDataDir,
  findNtMsgDb,
  findGroupInfoDb,
  findProfileInfoDb,
  findMiscDb,
  findMarketFaceDir,
  findEmojiRecvDir,
  findPersonalEmojiDir,
  findEmojiRelatedDir,
  findPicDir,
  findPttDir,
  findVideoDir,
  findFileDir,
  findQqWrapperNode,
  findQqMajorNode,
  findQqWrapperNodeFromProtocolExe,
  findQqMajorNodeFromProtocolExe,
  findQqExeFromProtocolExe,
} from './paths';
import { findQqExe, findQqInstallRoot } from './registry';

/**
 * Build a Win32 Platform.
 *
 * `getOverrideRoot` is the seam for the user-picked Tencent Files directory:
 * it's read fresh on every path lookup (so changing the override mid-session
 * takes effect immediately) and, when it points at an existing directory, wins
 * over auto-detection across the WHOLE platform — login.db decrypt, per-account
 * db lookup, and stats all resolve against it. Defaults to "no override" so
 * tests and callers that don't care can omit it.
 */
export function createWin32Platform(
  native: NativeBundle,
  getOverrideRoot: () => string | null = () => null,
  /**
   * The exe that the OS says handles `tencent://` (QQNT's `timwp.exe`, resolved
   * in the main process via electron's `getApplicationInfoForProtocol`). It
   * lives in the same `resources/app` dir as `wrapper.node`, so every install
   * path derives from it without a registry key — which covers the users whose
   * `Uninstall\QQ` registry entry is missing / relocated / renamed. Read lazily
   * so a probe that finishes after platform construction still flows in.
   * Defaults to "unknown" ⇒ pure registry behavior (tests / non-electron hosts).
   */
  getProtocolExe: () => string | null = () => null,
): Platform {
  // Resolve the override lazily per call; ignore a stale/removed path so we
  // gracefully fall back to detection rather than returning dead paths.
  const override = (): string | null => {
    const o = getOverrideRoot();
    return o && existsSync(o) ? o : null;
  };
  // The protocol-handler exe, only when it still exists on disk.
  const protocolExe = (): string | null => {
    const p = getProtocolExe();
    return p && existsSync(p) ? p : null;
  };
  return {
    kind: 'win32',
    native,
    appDataRoot: () => {
      const base = process.env.APPDATA;
      if (!base) {
        throw new Error('%APPDATA% not set — cannot derive weq user data root on win32');
      }
      return join(base, 'weq');
    },
    tencentFilesRoots: () => candidateTencentFilesRoots(undefined, override()),
    loginDbPath: () => findLoginDb(undefined, override()),
    accountDir: (uin: string) => findAccountDir(uin, undefined, override()),
    ntDbDir: (uin: string) => findNtDbDir(uin, undefined, override()),
    ntDataDir: (uin: string) => findNtDataDir(uin, undefined, override()),
    ntMsgDbPath: (uin: string) => findNtMsgDb(uin, undefined, override()),
    groupInfoDbPath: (uin: string) => findGroupInfoDb(uin, undefined, override()),
    profileInfoDbPath: (uin: string) => findProfileInfoDb(uin, undefined, override()),
    miscDbPath: (uin: string) => findMiscDb(uin, undefined, override()),
    buddyMsgFtsDbPath: (uin: string) => findBuddyMsgFtsDb(uin, undefined, override()),
    groupMsgFtsDbPath: (uin: string) => findGroupMsgFtsDb(uin, undefined, override()),
    emojiResourceDir: (uin: string) => findEmojiResourceDir(uin, undefined, override()),
    marketFaceDir: (uin: string) => findMarketFaceDir(uin, undefined, override()),
    emojiRecvDir: (uin: string) => findEmojiRecvDir(uin, undefined, override()),
    personalEmojiDir: (uin: string) => findPersonalEmojiDir(uin, undefined, override()),
    emojiRelatedDir: (uin: string) => findEmojiRelatedDir(uin, undefined, override()),
    picDir: (uin: string) => findPicDir(uin, undefined, override()),
    pttDir: (uin: string) => findPttDir(uin, undefined, override()),
    videoDir: (uin: string) => findVideoDir(uin, undefined, override()),
    fileDir: (uin: string) => findFileDir(uin, undefined, override()),
    qqExePath: () => {
      const p = protocolExe();
      const viaProto = p ? findQqExeFromProtocolExe(p) : null;
      return viaProto ?? findQqExe();
    },
    qqWrapperNodePath: () => {
      const p = protocolExe();
      const viaProto = p ? findQqWrapperNodeFromProtocolExe(p) : null;
      if (viaProto) return viaProto;
      const root = findQqInstallRoot();
      return root ? findQqWrapperNode(root) : null;
    },
    qqMajorNodePath: () => {
      const p = protocolExe();
      const viaProto = p ? findQqMajorNodeFromProtocolExe(p) : null;
      if (viaProto) return viaProto;
      const root = findQqInstallRoot();
      return root ? findQqMajorNode(root) : null;
    },
    qqVersion: () => {
      const p = protocolExe();
      const viaProto = p ? findQqWrapperNodeFromProtocolExe(p) : null;
      if (viaProto) return readQqVersion(viaProto);
      const root = findQqInstallRoot();
      return readQqVersion(root ? findQqWrapperNode(root) : null);
    },
    // win32's native probe keys off the numeric uin; baseDir/uid are ignored.
    isQqLoggedIn: (uin: string) => {
      try {
        return native.ntHelper.isQqLoggedIn(uin);
      } catch {
        return false;
      }
    },
    // QQ records its own running-instance count in versions/setting.json —
    // same source as linux, so the bootstrap display reads one value everywhere.
    launcherCount: () => {
      const p = protocolExe();
      const root = p ? join(dirname(p), '..', '..', '..', '..') : findQqInstallRoot();
      return readLauncherCount(root);
    },
    /**
     * Attribute this account to a running QQ pid via the account's `nt_msg.db`
     * handle (Restart Manager). The RM holder list can contain non-QQ
     * processes (WeQ itself reads the DB) — filter by process name. A probe
     * that ran successfully but found no QQ holder means the account is not
     * signed in: return null instead of falling back to the port probe (which
     * is slower and known to report stale pids). The legacy port probe is only
     * reached when the db-lock probe itself could not run (no `nt_msg.db`) or
     * errored (e.g. permission denied, cross-session) — i.e. we can't trust
     * the lock-based answer.
     */
    resolveQqPid: (uin: string) => {
      const dbPath = findNtMsgDb(uin, undefined, override());
      if (dbPath) {
        try {
          const probe = native.ntHelper.probeDbLock(dbPath);
          if (probe.success) {
            const holder = probe.holders.find((h) => isQqProcessName(h.name));
            // Probe succeeded: no QQ holding the DB ⇒ not logged in. Only a
            // failed/unavailable probe falls through to the port probe below.
            return holder ? holder.pid : null;
          }
          /* probe reported failure (e.g. no permission) — port probe below */
        } catch {
          /* db-lock probe unavailable — fall through to the port probe */
        }
      }
      return probeQqPidByPort(native.ntHelper, uin);
    },
  };
}

/**
 * Match a holder's process name against QQ, case-insensitively — Restart
 * Manager `strAppName` reports `QQ` / `QQ.exe`, Linux `/proc/<pid>/comm`
 * reports `qq`. A trailing `.exe` is stripped so one rule covers both.
 */
function isQqProcessName(name: string): boolean {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/\.exe$/, '') === 'qq'
  );
}

/**
 * Legacy fallback: enumerate running QQ processes and port-probe each for the
 * account's uin. Only reached when the db-lock probe could not be trusted: the
 * `nt_msg.db` wasn't found, the probe threw, or it reported failure (e.g. no
 * permission) — never when a successful probe found no QQ holder (offline).
 * The port probe is strictly weaker (the process scan is known to report stale
 * pids), so every candidate is verified against the account uin before being
 * accepted.
 */
function probeQqPidByPort(ntHelper: NtHelperBinding, uin: string): number | null {
  try {
    for (const pid of ntHelper.getQqProcesses()) {
      const info = ntHelper.probeQqLoginInfo(pid);
      if (info && info.uin === uin && info.loggedIn) return pid;
    }
  } catch {
    /* probe unavailable */
  }
  return null;
}

// Re-export the pure helpers so the service layer / tests can use them
// without depending on a Platform instance.
export {
  candidateTencentFilesRoots,
  isTencentFilesRoot,
  pickTencentFilesRoot,
  findLoginDb,
  findNtDbDir,
  findNtDataDir,
  findNtMsgDb,
  findGroupInfoDb,
  findProfileInfoDb,
  findMiscDb,
  findBuddyMsgFtsDb,
  findGroupMsgFtsDb,
  findEmojiResourceDir,
  findMarketFaceDir,
  findEmojiRecvDir,
  findPersonalEmojiDir,
  findEmojiRelatedDir,
  findPicDir,
  findPttDir,
  findVideoDir,
  findFileDir,
  tencentFilesRootFromUserDataInfo,
} from './paths';
export { findQqInstallRoot, findQqExe } from './registry';
export {
  resolveQqVersionDir,
  findQqWrapperNode,
  findQqExeFromProtocolExe,
  findQqWrapperNodeFromProtocolExe,
  findQqMajorNodeFromProtocolExe,
} from './paths';

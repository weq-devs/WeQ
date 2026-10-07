/**
 * macOS Platform implementation. Composes the pure path helpers + native
 * bundle into one object.
 *
 * Two seams differ from linux:
 *
 *   1. `getOverrideRoot` — a user-picked QQ data dir (same idea as win32's
 *      Tencent Files override). Read fresh per call; when it points at an
 *      existing dir it wins over the hard-coded container path.
 *
 *   2. `getUidForUin` — the account path helpers derive the on-disk account
 *      directory from the string `uid` (the folder is `nt_qq_<hash>` where
 *      `hash = md5(md5(uid) + "nt_kernel")`), but the `Platform` interface is
 *      keyed by numeric `uin`. This callback maps one to the other; the app
 *      wires it to read `uid` out of the saved account config. Returns null
 *      when the uid isn't known yet — path helpers then return null, exactly
 *      as they would for a missing directory.
 *
 * macOS native differences (see `nt_helper/src`):
 *   - `isQqLoggedIn` / `resolveQqPid` / `probeDbLock` enumerate the processes
 *     that have the account's `nt_msg.db` open via `libproc`
 *     (`proc_pidfdinfo`), the analog of Windows' Restart Manager — not linux's
 *     single-holder `F_GETLK`. Each holder is name-tagged via `proc_name`.
 *   - Memory scanning (`scanSessionMaterial` / `scanKeyFromDatabase`) only works
 *     with SIP off AND root (QQ runs hardened, so SIP alone blocks
 *     `task_for_pid`). {@link Platform.sipEnabled} answers that first question
 *     without any privilege, so callers can skip the scan instead of
 *     discovering it from a failure.
 */

import { readSipEnabled, type NativeBundle } from '@weq/native';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Platform } from '../types';
import { readLauncherCount, readQqVersion } from '../qq_meta';
import {
  candidateQqRoots,
  pickQqRoot,
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
  findQqExe,
  findQqWrapperNode,
  findQqMajorNode,
} from './paths';

/**
 * Build a macOS Platform.
 *
 * `getOverrideRoot` — lazily-read user override for the QQ data root.
 * `getUidForUin` — resolve an account's string uid from its numeric uin
 *   (backed by the saved account config). Defaults to "unknown" so callers
 *   that don't need per-account paths can omit it.
 */
export function createDarwinPlatform(
  native: NativeBundle,
  getOverrideRoot: () => string | null = () => null,
  getUidForUin: (uin: string) => string | null = () => null,
): Platform {
  const override = (): string | null => {
    const o = getOverrideRoot();
    return o && existsSync(o) ? o : null;
  };
  // Resolve uin→uid at call time; empty string ⇒ path helpers short-circuit
  // to null (no dir can be derived), matching a "not found on disk" outcome.
  const uid = (uin: string): string => getUidForUin(uin) ?? '';

  const home = undefined; // let the helpers default to os.homedir()

  /**
   * Resolve an account's hosting QQ pid by enumerating who has the account's
   * `nt_msg.db` open (`libproc` via `probeDbLock`) — the macOS analog of
   * Windows' Restart Manager, same as linux but not via `F_GETLK`.
   *
   * The holder list is name-tagged (`proc_name`), so we accept only a holder
   * whose name is QQ — exactly like linux/win32. A non-QQ holder (WeQ's own
   * read connection, another reader) must never be returned: the probe can
   * list more than one process, and its order is not meaningful.
   *
   * Returns null both when the account is not signed in and when the probe
   * couldn't run. There is deliberately no port-probe fallback.
   */
  const resolveQqPid = (uin: string): number | null => {
    const dbPath = findNtMsgDb(uid(uin), home, override());
    if (!dbPath) return null;
    try {
      const probe = native.ntHelper.probeDbLock(dbPath);
      if (!probe.success) return null;
      const holder = probe.holders.find((h) => isQqProcessName(h.name));
      return holder ? holder.pid : null;
    } catch {
      return null;
    }
  };

  return {
    kind: 'darwin',
    native,
    // macOS convention: per-user app data lives in ~/Library/Application
    // Support/<app> (the QQ data root itself is under the same tree, inside
    // the com.tencent.qq container).
    appDataRoot: () => join(homedir(), 'Library', 'Application Support', 'weq'),
    tencentFilesRoots: () => candidateQqRoots(home, override()),
    loginDbPath: () => findLoginDb(home, override()),
    qqDataRoot: () => pickQqRoot(home, override()),
    accountDir: (u: string) => findAccountDir(uid(u), home, override()),
    ntDbDir: (u: string) => findNtDbDir(uid(u), home, override()),
    ntDataDir: (u: string) => findNtDataDir(uid(u), home, override()),
    ntMsgDbPath: (u: string) => findNtMsgDb(uid(u), home, override()),
    groupInfoDbPath: (u: string) => findGroupInfoDb(uid(u), home, override()),
    profileInfoDbPath: (u: string) => findProfileInfoDb(uid(u), home, override()),
    miscDbPath: (u: string) => findMiscDb(uid(u), home, override()),
    buddyMsgFtsDbPath: (u: string) => findBuddyMsgFtsDb(uid(u), home, override()),
    groupMsgFtsDbPath: (u: string) => findGroupMsgFtsDb(uid(u), home, override()),
    emojiResourceDir: (u: string) => findEmojiResourceDir(uid(u), home, override()),
    marketFaceDir: (u: string) => findMarketFaceDir(uid(u), home, override()),
    emojiRecvDir: (u: string) => findEmojiRecvDir(uid(u), home, override()),
    personalEmojiDir: (u: string) => findPersonalEmojiDir(uid(u), home, override()),
    emojiRelatedDir: (u: string) => findEmojiRelatedDir(uid(u), home, override()),
    picDir: (u: string) => findPicDir(uid(u), home, override()),
    pttDir: (u: string) => findPttDir(uid(u), home, override()),
    videoDir: (u: string) => findVideoDir(uid(u), home, override()),
    fileDir: (u: string) => findFileDir(uid(u), home, override()),
    qqExePath: () => findQqExe(),
    qqWrapperNodePath: () => {
      const exe = findQqExe();
      return exe ? findQqWrapperNode(exe) : null;
    },
    qqMajorNodePath: () => {
      const exe = findQqExe();
      return exe ? findQqMajorNode(exe) : null;
    },
    qqVersion: () => {
      const exe = findQqExe();
      return readQqVersion(exe ? findQqWrapperNode(exe) : null);
    },
    // 在线判定只认数据库锁：该账号的 `nt_msg.db` 有没有被 QQ 持有。
    // 路径由本层解析（override→容器路径候选链，没有硬编码），调用方只给 uin。
    isQqLoggedIn: (u: string) => resolveQqPid(u) !== null,
    // QQ records its own running-instance count in versions/setting.json —
    // same source as linux, under the container root.
    launcherCount: () => readLauncherCount(pickQqRoot(home, override())),
    resolveQqPid: (u: string) => resolveQqPid(u),
    // 读内存的硬门槛：SIP 开着时 `task_for_pid` 连 root 都拒（QQ 带强化运行时）。
    // 所以这一档必须能在**尝试之前**问出来 —— 见 `readSipEnabled`。
    sipEnabled: () => readSipEnabled(),
  };
}

/**
 * Match a holder's process name against QQ, case-insensitively —
 * Linux `/proc/<pid>/comm` reports `qq`; macOS's libproc/NSRunningApplication
 * reports the app display name. A trailing `.exe` is stripped so one rule
 * covers the win32 variant too.
 */
function isQqProcessName(name: string): boolean {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/\.exe$/, '') === 'qq'
  );
}

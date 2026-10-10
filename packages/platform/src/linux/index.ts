/**
 * Linux Platform implementation. Composes the pure path helpers + native
 * bundle into one object.
 *
 * Two seams differ from win32:
 *
 *   1. `getOverrideRoot` — a user-picked QQ data dir (same idea as win32's
 *      Tencent Files override). Read fresh per call; when it points at an
 *      existing dir it wins over the hard-coded `~/.config/QQ`.
 *
 *   2. `getUidForUin` — the account path helpers derive the on-disk account
 *      directory from the string `uid` (the folder is `nt_qq_<hash>` where
 *      `hash = md5(md5(uid) + "nt_kernel")`), but the `Platform` interface is
 *      keyed by numeric `uin`. This callback maps one to the other; the app
 *      wires it to read `uid` out of the saved account config. Returns null
 *      when the uid isn't known yet — path helpers then return null, exactly
 *      as they would for a missing directory.
 */

import type { NativeBundle } from '@weq/native';
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
 * Build a Linux Platform.
 *
 * `getOverrideRoot` — lazily-read user override for the QQ data root.
 * `getUidForUin` — resolve an account's string uid from its numeric uin
 *   (backed by the saved account config). Defaults to "unknown" so callers
 *   that don't need per-account paths can omit it.
 */
export function createLinuxPlatform(
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
   * Resolve an account's hosting QQ pid from its `nt_msg.db` fcntl write lock
   * (`F_GETLK`) — the one and only "which instance is this account on?" probe.
   * `F_GETLK` reports only the holder pid (WeQ reads the DB without taking a
   * write lock), which is then name-checked against `/proc/<pid>/comm` so a
   * non-QQ holder can never be accepted.
   *
   * Returns null both when the account is not signed in (the probe ran and
   * found no QQ holder) and when the probe itself couldn't run (no
   * `nt_msg.db`, permission denied). There is deliberately no port-probe
   * fallback: it was slower and known to report stale pids.
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
    kind: 'linux',
    native,
    appDataRoot: () => {
      const xdg = process.env.XDG_CONFIG_HOME;
      const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
      return join(base, 'weq');
    },
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
    // 路径由本层解析（override→~/.config/QQ 候选链，没有硬编码），调用方只给 uin。
    isQqLoggedIn: (u: string) => resolveQqPid(u) !== null,
    // QQ records its own running-instance count in versions/setting.json.
    launcherCount: () => readLauncherCount(pickQqRoot(home, override())),
    resolveQqPid: (u: string) => resolveQqPid(u),
    // SIP 是 macOS 的东西；Linux 上读内存的门槛是 yama ptrace_scope（可用，只是要
    // 关掉或提权），没有「根本读不了」这一档，所以恒为 null。
    sipEnabled: () => null,
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

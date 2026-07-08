/**
 * Win32 Platform implementation. Composes the pure path helpers + registry
 * lookup + native bundle into one object.
 *
 * `createWin32Platform` deliberately takes the native bundle as a
 * constructor argument — it does NOT call `loadNative()` itself. This
 * keeps Platform testable: pass a stub native bundle in unit tests, the
 * real bundle in production.
 */

import type { NativeBundle } from '@weq/native';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from '../types';
import {
  candidateTencentFilesRoots,
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
  findPicDir,
  findPttDir,
  findVideoDir,
  findFileDir,
  findQqWrapperNode,
  pickTencentFilesRoot,
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
): Platform {
  // Resolve the override lazily per call; ignore a stale/removed path so we
  // gracefully fall back to detection rather than returning dead paths.
  const override = (): string | null => {
    const o = getOverrideRoot();
    return o && existsSync(o) ? o : null;
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
    avatarCacheDir: () => {
      const base = process.env.APPDATA;
      if (!base) {
        throw new Error('%APPDATA% not set — cannot derive weq avatar cache dir on win32');
      }
      return join(base, 'weq', 'cache', 'avatar');
    },
    tencentFilesRoots: () => candidateTencentFilesRoots(undefined, override()),
    loginDbPath: () => findLoginDb(undefined, override()),
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
    picDir: (uin: string) => findPicDir(uin, undefined, override()),
    pttDir: (uin: string) => findPttDir(uin, undefined, override()),
    videoDir: (uin: string) => findVideoDir(uin, undefined, override()),
    fileDir: (uin: string) => findFileDir(uin, undefined, override()),
    qqExePath: () => findQqExe(),
    qqWrapperNodePath: () => {
      const root = findQqInstallRoot();
      return root ? findQqWrapperNode(root) : null;
    },
  };
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
  findPicDir,
  findPttDir,
  findVideoDir,
  findFileDir,
  tencentFilesRootFromUserDataInfo,
} from './paths';
export { findQqInstallRoot, findQqExe } from './registry';
export { resolveQqVersionDir, findQqWrapperNode } from './paths';

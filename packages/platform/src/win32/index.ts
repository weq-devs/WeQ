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
import { join } from 'node:path';
import type { Platform } from '../types';
import {
  candidateTencentFilesRoots,
  findBuddyMsgFtsDb,
  findGroupMsgFtsDb,
  findEmojiResourceDir,
  findLoginDb,
  findNtDbDir,
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

export function createWin32Platform(native: NativeBundle): Platform {
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
    tencentFilesRoots: () => candidateTencentFilesRoots(),
    loginDbPath: () => findLoginDb(),
    ntDbDir: (uin: string) => findNtDbDir(uin),
    ntMsgDbPath: (uin: string) => findNtMsgDb(uin),
    groupInfoDbPath: (uin: string) => findGroupInfoDb(uin),
    profileInfoDbPath: (uin: string) => findProfileInfoDb(uin),
    miscDbPath: (uin: string) => findMiscDb(uin),
    buddyMsgFtsDbPath: (uin: string) => findBuddyMsgFtsDb(uin),
    groupMsgFtsDbPath: (uin: string) => findGroupMsgFtsDb(uin),
    emojiResourceDir: (uin: string) => findEmojiResourceDir(uin),
    marketFaceDir: (uin: string) => findMarketFaceDir(uin),
    emojiRecvDir: (uin: string) => findEmojiRecvDir(uin),
    picDir: (uin: string) => findPicDir(uin),
    pttDir: (uin: string) => findPttDir(uin),
    videoDir: (uin: string) => findVideoDir(uin),
    fileDir: (uin: string) => findFileDir(uin),
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
  pickTencentFilesRoot,
  findLoginDb,
  findNtDbDir,
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

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
  findLoginDb,
  findNtMsgDb,
  findGroupInfoDb,
  findProfileInfoDb,
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
    tencentFilesRoots: () => candidateTencentFilesRoots(),
    loginDbPath: () => findLoginDb(),
    ntMsgDbPath: (uin: string) => findNtMsgDb(uin),
    groupInfoDbPath: (uin: string) => findGroupInfoDb(uin),
    profileInfoDbPath: (uin: string) => findProfileInfoDb(uin),
    buddyMsgFtsDbPath: (uin: string) => findBuddyMsgFtsDb(uin),
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
  findNtMsgDb,
  findGroupInfoDb,
  findProfileInfoDb,
  findBuddyMsgFtsDb,
  tencentFilesRootFromUserDataInfo,
} from './paths';
export { findQqInstallRoot, findQqExe } from './registry';
export { resolveQqVersionDir, findQqWrapperNode } from './paths';

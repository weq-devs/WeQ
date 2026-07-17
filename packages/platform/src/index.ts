/**
 * `@weq/platform` — OS-specific path resolution and bootstrap helpers.
 *
 * win32 and linux are implemented; darwin is pending. Each OS lives in its
 * own folder exporting a `create<Os>Platform` factory returning the same
 * `Platform` shape.
 */

export type { Platform } from './types';
export { createWin32Platform } from './win32';
export { createLinuxPlatform } from './linux';
// Pure path helpers (used directly by service tests / tooling that don't hold a
// Platform instance). The win32 barrel is the source of truth.
export {
  findNtDbDir,
  findNtMsgDb,
  findGroupInfoDb,
  findProfileInfoDb,
  findMiscDb,
  findEmojiResourceDir,
  isTencentFilesRoot,
} from './win32';
// Linux pure helpers — the two-location login.db list + the uid→dir hash are
// needed by the service layer (account listing / login.db merge).
export {
  accountDirName as linuxAccountDirName,
  findLoginDbs as linuxFindLoginDbs,
  defaultQqDataRoot as linuxDefaultQqDataRoot,
  findQqMajorNode as linuxFindQqMajorNode,
} from './linux/paths';

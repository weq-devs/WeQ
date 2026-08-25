/**
 * `@weq/platform` — OS-specific path resolution and bootstrap helpers.
 *
 * win32, linux and darwin are implemented. Each OS lives in its own folder
 * exporting a `create<Os>Platform` factory returning the same `Platform`
 * shape.
 */

export type { Platform } from './types';
export { createWin32Platform } from './win32';
export { createLinuxPlatform } from './linux';
export { createDarwinPlatform } from './darwin';
// Resource-root redirection: wraps a Platform so a static / imported account
// resolves its databases and media somewhere other than the local QQ install.
export { withResourceRoots } from './resource_roots';
export type { MediaDirKey, ResourceRootOverrides } from './resource_roots';
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
// macOS pure helpers — same two-location login.db list + uid→dir hash as
// linux, but rooted at the sandboxed container path.
export {
  accountDirName as darwinAccountDirName,
  findLoginDbs as darwinFindLoginDbs,
  defaultQqDataRoot as darwinDefaultQqDataRoot,
  findQqMajorNode as darwinFindQqMajorNode,
} from './darwin/paths';

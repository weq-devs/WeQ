/**
 * `@weq/platform` — OS-specific path resolution and bootstrap helpers.
 *
 * win32, linux and darwin are implemented. Each OS lives in its own folder
 * exporting a `create<Os>Platform` factory returning the same `Platform`
 * shape.
 */

export type { Platform } from './types';
import { candidateQqRoots as darwinQqRoots } from './darwin/paths';
import { candidateQqRoots as linuxQqRoots } from './linux/paths';
import { candidateTencentFilesRoots } from './win32/paths';

/** QQ 数据位置与 native 无关，文件配置初始化之前也能解析。 */
export function candidateQqDataRoots(override?: string | null): string[] {
  if (process.platform === 'win32') return candidateTencentFilesRoots(undefined, override);
  if (process.platform === 'darwin') return darwinQqRoots(undefined, override);
  return linuxQqRoots(undefined, override);
}

export { weqAppDataRoot } from './app_data_root';
// QQ 元数据（版本 / 启动器实例数）纯函数，跨平台共用同一份实现。
export { readQqVersion, readLauncherCount } from './qq_meta';
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
  normalizeQqDataRoot,
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

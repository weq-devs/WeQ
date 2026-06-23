/**
 * `@weq/platform` — OS-specific path resolution and bootstrap helpers.
 *
 * Only win32 is implemented today. Adding mac/linux means a sibling
 * `darwin/` or `linux/` folder exporting the same `Platform` shape, plus
 * a wiring branch here.
 */

export type { Platform } from './types';
export { createWin32Platform } from './win32';
// Pure path helpers (used directly by service tests / tooling that don't hold a
// Platform instance). The win32 barrel is the source of truth.
export {
  findNtDbDir,
  findNtMsgDb,
  findGroupInfoDb,
  findProfileInfoDb,
  findMiscDb,
  findEmojiResourceDir,
} from './win32';

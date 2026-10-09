/**
 * `@weq/native` — the only package allowed to `require('*.node')`.
 *
 * Consumers:
 *   - `@weq/db`        wraps `NtHelperBinding` in `QqDb` for per-database
 *                      access (one cached connection per file)
 *   - `@weq/platform`  exposes the loaded bundle via `platform.native`
 *
 * Nothing in this package depends on Electron at runtime — `process.resourcesPath`
 * is accessed defensively so non-Electron tests can still load via `WEQ_NATIVE_DIR`.
 */

export {
  loadNative,
  loadNativeSafe,
  resetNativeCache,
  resolveNtHelperPath,
  getNativeLogRoot,
  INIT_ERROR_MESSAGES,
} from './loader';
export type { LoadNativeOptions, NativeLoadResult } from './loader';
export { MAX_FAST_DECRYPT_BYTES, selectDatabaseDecryptMethod } from './decrypt';
export type { DatabaseDecryptMode, DatabaseDecryptMethod } from './decrypt';
export { readSipEnabled, resetSipCache, parseSipStatus } from './darwin/sip';
export {
  resolveSudoPath,
  runSudo,
  linuxSudoErrorHint,
  YAMA_PTRACE_SCOPE_PATH,
  readYamaPtraceScope,
  writeYamaPtraceScope,
} from './linux/install';
export type { ElevatedResult } from './linux/install';
export { isOnPrivateFuseMount } from './linux/fuse_mounts';
export * from './types';

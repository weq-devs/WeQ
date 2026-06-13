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

export { loadNative, resetNativeCache } from './loader';
export type { LoadNativeOptions } from './loader';
export { NineBirdBootstrap } from './ninebird';
export type {
  QrLoginOptions,
  QuickLoginOptions,
  AccountListOptions,
  LoginSession,
  AccountListSession,
} from './ninebird';
export * from './types';

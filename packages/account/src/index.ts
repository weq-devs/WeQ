/**
 * `@weq/account` — per-account session lifecycle.
 *
 * Construct an `AccountSession` with `openAccount(platform, { uin, dbKey })`.
 * Account services (in `@weq/service`) take a session in their constructor.
 */

export { openAccount } from './session';
export type { AccountContext, AccountSession, LastRowIdMaps } from './session';

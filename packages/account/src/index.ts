/**
 * `@weq/account` — per-account session lifecycle.
 *
 * Construct an `AccountSession` with `openAccount(platform, { uin, dbKey })`.
 * Account services (in `@weq/service`) take a session in their constructor.
 */

export { openAccount, algoFor } from './session';
export type {
  AccountContext,
  AccountSalvageOptions,
  AccountSession,
  LastRowIdMaps,
} from './session';
export type { CorruptionSuspectInfo } from '@weq/db';
export {
  openStaticAccount,
  peekStaticSelfUin,
  deriveAndroidDbKey,
  resolveStaticSelfIdentity,
} from './static_session';
export type {
  AndroidDerivedIdentity,
  AndroidKeyOptions,
  AndroidLoginCandidate,
  OpenStaticAccountOptions,
  StaticSelfIdentityOptions,
  StaticSelfPreview,
} from './static_session';

/**
 * Resource-root redirection — a `Platform` decorator.
 *
 * Every resource lookup in the service layer goes through `platform.picDir(uin)`
 * / `ntDataDir(uin)` / `ntDbDir(uin)` / …, which resolve against the LOCAL QQ
 * install keyed by uin. That is correct for an online account, but wrong for a
 * static (offline) one: its uin is read out of the imported `profile_info_v6`,
 * so on win32 those lookups silently hit `<Tencent Files>/<uin>/…` — the local
 * account's data, not the imported snapshot. Media reads then show the wrong
 * files, and `ResourceCleanupService` would delete them.
 *
 * Rather than thread an explicit root through ~13 service constructors, we wrap
 * the Platform once and let every consumer stay unchanged. Three groups:
 *
 *   - **db**     `ntDbDir` and friends → the directory the session actually
 *                opened. Fixes the db browser / `emoji.db` lookups reading the
 *                local install instead of the imported folder.
 *   - **media**  `nt_data` and its children → passed through when the account is
 *                bound to a local native directory, else all null. Null is the
 *                safe answer: the media pipeline already falls back to the CDN
 *                on a local miss (see `media_protocol.ts`), so nothing else
 *                needs to know.
 *   - **rest**   untouched. In particular `isQqLoggedIn` / `native` / `qqExePath`
 *                must keep pointing at the real machine, or online detection for
 *                a static account would break.
 *
 * `overrides` is read lazily on every call so a binding toggled at runtime takes
 * effect without reopening the account.
 *
 * This is also the seam for future Android backups (a `com.tencent.mobileqq`
 * folder ships its own complete media tree): point `media` at the unpacked tree
 * and the service layer needs no changes at all.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from './types';

/** Per-account media directories, all rooted under `nt_data`. */
export type MediaDirKey =
  | 'accountDir'
  | 'ntDataDir'
  | 'picDir'
  | 'pttDir'
  | 'videoDir'
  | 'fileDir'
  | 'emojiResourceDir'
  | 'marketFaceDir'
  | 'emojiRecvDir'
  | 'personalEmojiDir'
  | 'emojiRelatedDir';

const MEDIA_DIR_KEYS: readonly MediaDirKey[] = [
  'accountDir',
  'ntDataDir',
  'picDir',
  'pttDir',
  'videoDir',
  'fileDir',
  'emojiResourceDir',
  'marketFaceDir',
  'emojiRecvDir',
  'personalEmojiDir',
  'emojiRelatedDir',
];

/**
 * Database files the session opened from a known directory. `nt_msg.db` is
 * absent on purpose — the session already holds its resolved `msgDbPath`.
 */
type DbPathKey =
  | 'groupInfoDbPath'
  | 'profileInfoDbPath'
  | 'miscDbPath'
  | 'buddyMsgFtsDbPath'
  | 'groupMsgFtsDbPath';

const DB_FILENAMES: Readonly<Record<DbPathKey, string>> = {
  groupInfoDbPath: 'group_info.db',
  profileInfoDbPath: 'profile_info.db',
  miscDbPath: 'misc.db',
  buddyMsgFtsDbPath: 'buddy_msg_fts.db',
  groupMsgFtsDbPath: 'group_msg_fts.db',
};

export interface ResourceRootOverrides {
  /**
   * The directory holding this account's `.db` files. Redirects `ntDbDir` and
   * the per-file db paths. Omit / null to leave db resolution alone.
   */
  dbDir?: string | null;
  /**
   * - `'passthrough'` (default) — resolve media against the local install
   * - `'none'` — every media directory resolves to null
   * - object — per-key absolute paths; keys left out fall back to null
   */
  media?: 'passthrough' | 'none' | Partial<Record<MediaDirKey, string | null>>;
}

/**
 * Wrap `base` so resource lookups honour `overrides`. Non-resource members
 * (`native`, `kind`, `appDataRoot`, `qqExePath`, `isQqLoggedIn`, …) pass
 * through untouched.
 */
export function withResourceRoots(
  base: Platform,
  overrides: () => ResourceRootOverrides,
): Platform {
  const mediaDir = (key: MediaDirKey, uin: string): string | null => {
    const media = overrides().media ?? 'passthrough';
    if (media === 'passthrough') return base[key](uin);
    if (media === 'none') return null;
    return media[key] ?? null;
  };

  const wrapped = { ...base } as Platform;

  for (const key of MEDIA_DIR_KEYS) {
    wrapped[key] = (uin: string) => mediaDir(key, uin);
  }

  wrapped.ntDbDir = (uin: string) => overrides().dbDir ?? base.ntDbDir(uin);

  for (const [key, filename] of Object.entries(DB_FILENAMES) as [DbPathKey, string][]) {
    wrapped[key] = (uin: string) => {
      const dir = overrides().dbDir;
      if (!dir) return base[key](uin);
      // The interface contracts these as "null when absent" — an optional db
      // (fts indexes, misc.db) simply may not be in the imported folder.
      const path = join(dir, filename);
      return existsSync(path) ? path : null;
    };
  }

  return wrapped;
}

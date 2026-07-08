/**
 * Win32 path-resolution helpers — pure functions over the filesystem.
 *
 * QQ NT's storage layout:
 *   <TencentFilesRoot>/<uin>/nt_qq/nt_db/nt_msg.db   ← per-account msg db
 *   <TencentFilesRoot>/nt_qq/global/nt_db/login.db   ← global accounts
 *
 * `TencentFilesRoot` can live in several places (in priority order):
 *   0. UserDataSavePath from <Public>/Documents/Tencent/QQ/UserDataInfo.ini
 *   1. ~/Documents/Tencent Files
 *   2. ~/<Admin*>/Documents/Tencent Files            ← legacy/admin profiles
 *   3. ~/Tencent Files                               ← portable installs
 *
 * QQ.exe layout:
 *   <QQRoot>/QQ.exe
 *   <QQRoot>/versions/<curVersion>/resources/app/wrapper.node
 *   <QQRoot>/versions/config.json                    ← lists curVersion
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------- Tencent Files (user data) ------------------------------------

/**
 * Authoritative source: QQ writes the real user-data directory into a
 * machine-wide ini at `<Public>/Documents/Tencent/QQ/UserDataInfo.ini`.
 * `<Public>` sits next to the user's home (e.g. `C:\Users\Public` alongside
 * `C:\Users\<name>`), so we resolve it via `dirname(home)/Public`.
 *
 * The `[UserDataSet]` section's `UserDataSavePath` IS the Tencent Files root
 * (e.g. `D:\estkim\T\Tencent Files`). Returns null if the ini is missing,
 * unreadable, or has no usable `UserDataSavePath` — callers then fall back to
 * the hard-coded guesses below.
 */
export function tencentFilesRootFromUserDataInfo(home = homedir()): string | null {
  const ini = join(dirname(home), 'Public', 'Documents', 'Tencent', 'QQ', 'UserDataInfo.ini');
  let text: string;
  try {
    text = readFileSync(ini, 'utf-8');
  } catch {
    return null;
  }

  // Section-aware scan: only honor `UserDataSavePath` inside `[UserDataSet]`,
  // so we never pick up `[UserDataImportSet]`'s `OldVerDataPath`.
  let inUserDataSet = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      inUserDataSet = line.toLowerCase() === '[userdataset]';
      continue;
    }
    if (!inUserDataSet) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim().toLowerCase() !== 'userdatasavepath') continue;
    const value = line.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * True when `p`'s last path segment is literally `Tencent Files` (case- and
 * trailing-separator-insensitive). The user-data root QQ creates is always
 * `…\Tencent Files`; a path pointing one level too deep (e.g. the per-account
 * `…\Tencent Files\<uin>`) or anywhere else is rejected. Used to validate a
 * user-picked override before we trust it.
 */
export function isTencentFilesRoot(p: string): boolean {
  const trimmed = p.replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/]/).pop() ?? '';
  return base.trim().toLowerCase() === 'tencent files';
}

/**
 * Candidate roots in priority order. The caller iterates and checks
 * `existsSync` — we deliberately do NOT pre-filter here, because callers
 * sometimes need to know which roots were tried for error messages.
 *
 * A user-picked `overrideRoot` (when it exists on disk) is prepended so it
 * wins over every detected location — this is the single seam that makes the
 * whole platform (login.db decrypt, per-account db lookup, stats) honor a
 * manually-set data directory. Then we trust `UserDataInfo.ini` (the path QQ
 * itself recorded); only if that's unavailable do we fall back to the
 * hard-coded location guesses.
 */
export function candidateTencentFilesRoots(
  home = homedir(),
  overrideRoot?: string | null,
): string[] {
  const roots: string[] = [];
  if (overrideRoot && existsSync(overrideRoot)) roots.push(overrideRoot);
  const fromIni = tencentFilesRootFromUserDataInfo(home);
  if (fromIni) roots.push(fromIni);
  roots.push(
    join(home, 'Documents', 'Tencent Files'),
    join(home, 'Tencent Files'),
  );
  // Walk one level deep for `<home>/<Admin*>/Documents/Tencent Files`.
  // Some Windows builds nest the real Documents under a legacy admin profile.
  try {
    for (const entry of readdirSync(home)) {
      if (!entry.toLowerCase().startsWith('admin')) continue;
      const nested = join(home, entry, 'Documents', 'Tencent Files');
      roots.push(nested);
    }
  } catch {
    /* home unreadable — fall through with the two static roots */
  }
  // Dedupe so an override that equals a detected root isn't probed twice.
  return [...new Set(roots)];
}

/**
 * First `<root>/<...segments>` that exists, scanning every candidate root
 * (override-first). Shared by all the `find*` helpers below so override
 * threading lives in exactly one place.
 */
function firstExistingUnder(
  home: string,
  overrideRoot: string | null | undefined,
  ...segments: string[]
): string | null {
  for (const root of candidateTencentFilesRoots(home, overrideRoot)) {
    const candidate = join(root, ...segments);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** First Tencent Files root that exists on disk, or null. */
export function pickTencentFilesRoot(home = homedir()): string | null {
  for (const candidate of candidateTencentFilesRoots(home)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * `<root>/nt_qq/global/nt_db/login.db` if it exists on any candidate root.
 * Walks all roots (not just the picked one) because the user may have
 * Tencent Files in one place but legacy login.db in another.
 */
export function findLoginDb(home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, 'nt_qq', 'global', 'nt_db', 'login.db');
}

/** `<root>/<uin>/nt_qq/nt_db/nt_msg.db` for the first root that has it. */
export function findNtMsgDb(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db', 'nt_msg.db');
}

/** `<root>/<uin>/nt_qq/nt_db` for the first root that has it. */
export function findNtDbDir(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db');
}

/**
 * `<root>/<uin>/nt_qq/nt_data` for the first root that has it — QQ NT's media
 * data root (holds Pic/Video/Ptt/File/avatar/…). Used to place the WeQ 助手
 * avatar file where QQ itself reads it (`nt_data/avatar/weq/…`).
 */
export function findNtDataDir(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data');
}

/** `<root>/<uin>/nt_qq/nt_db/group_info.db` for the first root that has it. */
export function findGroupInfoDb(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db', 'group_info.db');
}

/** `<root>/<uin>/nt_qq/nt_db/profile_info.db` for the first root that has it. */
export function findProfileInfoDb(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db', 'profile_info.db');
}

/** `<root>/<uin>/nt_qq/nt_db/misc.db` for the first root that has it. */
export function findMiscDb(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db', 'misc.db');
}

/**
 * `<root>/<uin>/nt_qq/nt_db/buddy_msg_fts.db` for the first root that has it.
 *
 * QQ's full-text-search index for friends, co-located with `nt_msg.db` in the
 * same `nt_db` folder. Returns null if the account never built a search index.
 */
export function findBuddyMsgFtsDb(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db', 'buddy_msg_fts.db');
}

/**
 * `<root>/<uin>/nt_qq/nt_db/group_msg_fts.db` for the first root that has it.
 *
 * QQ's full-text-search index for groups, co-located with `nt_msg.db` in the
 * same `nt_db` folder. Returns null if the account never built a search index.
 */
export function findGroupMsgFtsDb(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db', 'group_msg_fts.db');
}

/**
 * `<root>/<uin>/nt_qq/nt_data/Emoji/BaseEmojiSyastems/EmojiSystermResource`
 * for the first root that has it.
 *
 * QQ NT keeps the built-in face resource set (apng + lottie, ~40MB) under each
 * account's `nt_data`. The tree is laid out `<faceId>/apng/<faceId>.png` and
 * `<faceId>/lottie/<faceId>.json` — identical across accounts, so any logged-in
 * uin resolves an equivalent set. `BaseEmojiSyastems` is QQ's own (misspelled)
 * folder name; copied verbatim.
 */
export function findEmojiResourceDir(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(
    home, overrideRoot, uin, 'nt_qq', 'nt_data', 'Emoji', 'BaseEmojiSyastems', 'EmojiSystermResource',
  );
}

/** `<root>/<uin>/nt_qq/nt_data/Emoji/marketface` for the first root that has it. */
export function findMarketFaceDir(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data', 'Emoji', 'marketface');
}

/**
 * `<root>/<uin>/nt_qq/nt_data/Emoji/emoji-recv` for the first root that has it.
 * Holds received animated emoji (pic subType 1): `<YYYY-MM>/Ori` and `/Thumb`,
 * no separate "original" file.
 */
export function findEmojiRecvDir(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data', 'Emoji', 'emoji-recv');
}

/** `<root>/<uin>/nt_qq/nt_data/Pic` for the first root that has it. */
export function findPicDir(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data', 'Pic');
}

/** `<root>/<uin>/nt_qq/nt_data/Ptt` for the first root that has it. */
export function findPttDir(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data', 'Ptt');
}

/** `<root>/<uin>/nt_qq/nt_data/Video` for the first root that has it. */
export function findVideoDir(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data', 'Video');
}

/** `<root>/<uin>/nt_qq/nt_data/File` for the first root that has it. */
export function findFileDir(uin: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data', 'File');
}

// ---------- QQ install (wrapper.node) ------------------------------------

/**
 * Given the QQ install root (the directory that holds `QQ.exe`), pick the
 * versions/<x> directory that wrapper.node lives in. Resolution rules:
 *   - exactly one subdir under versions/ → use it (skip config.json read)
 *   - zero subdirs                       → null
 *   - more than one                      → read versions/config.json,
 *                                          honor `curVersion`
 *
 * Returns null if the rules can't pin down a single directory.
 */
export function resolveQqVersionDir(qqRoot: string): string | null {
  const versionsDir = join(qqRoot, 'versions');
  if (!existsSync(versionsDir)) return null;

  let subdirs: string[];
  try {
    subdirs = readdirSync(versionsDir).filter((entry) => {
      try {
        return statSync(join(versionsDir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }

  if (subdirs.length === 0) return null;
  if (subdirs.length === 1) {
    const only = subdirs[0];
    return only ? join(versionsDir, only) : null;
  }

  // Multiple version dirs — consult config.json.
  const configPath = join(versionsDir, 'config.json');
  if (!existsSync(configPath)) return null;
  let parsed: { curVersion?: string };
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as { curVersion?: string };
  } catch {
    return null;
  }
  const cur = parsed.curVersion;
  if (!cur || !subdirs.includes(cur)) return null;
  return join(versionsDir, cur);
}

/** `<qqRoot>/versions/<cur>/resources/app/wrapper.node` if resolvable. */
export function findQqWrapperNode(qqRoot: string): string | null {
  const versionDir = resolveQqVersionDir(qqRoot);
  if (!versionDir) return null;
  const candidate = join(versionDir, 'resources', 'app', 'wrapper.node');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Linux path-resolution helpers — pure functions over the filesystem.
 *
 * QQ NT's storage layout on linux differs from win32 in two ways:
 *
 *   1. The data root is fixed at `~/.config/QQ` (there is no per-user
 *      "Tencent Files" relocation like on Windows, and no `UserDataInfo.ini`).
 *      A user-picked override is still honored as a fallback.
 *
 *   2. The per-account directory is a hashed name placed DIRECTLY under the
 *      root — `~/.config/QQ/nt_qq_<hash>/` — with no numeric-uin level and no
 *      `nt_qq` middle segment:
 *
 *        win32:  <root>/<uin>/nt_qq/nt_db/nt_msg.db
 *        linux:  <root>/nt_qq_<hash>/nt_db/nt_msg.db
 *
 *      where `<hash> = md5(md5(uid) + "nt_kernel")` (lowercase hex, no
 *      separator). Note this keys off the account's string `uid` (the `u_...`
 *      form), NOT the numeric uin. Verified against a live install:
 *      uid `u_LKt3AdAIMP-CUfn6ydzDzw` -> `nt_qq_2472b597…425e4186`.
 *
 * Inside the account directory (`nt_db/…`, `nt_data/Emoji/…`, `nt_data/Pic`,
 * …) the relative layout is byte-for-byte identical to win32.
 *
 * login.db lives in TWO places on linux and both are authoritative-ish:
 *   - `<root>/global/nt_db/login.db`        (primary, larger)
 *   - `<root>/nt_qq/global/nt_db/login.db`  (supplementary, smaller)
 * Callers decrypt both and merge, preferring `global/nt_db`.
 *
 * QQ install (for the launch-based key flows):
 *   /opt/QQ/qq                              (binary; no registry on linux)
 *   <qqRoot>/resources/app/wrapper.node     (protobuf descriptors)
 *   <qqRoot>/resources/app/major.node       (appid/qua anchor)
 *   ~/.config/QQ/versions/config.json       (curVersion)
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------- data root -----------------------------------------------------

/** Fixed per-user QQ data root on linux: `~/.config/QQ` (XDG-aware). */
export function defaultQqDataRoot(home = homedir()): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(home, '.config');
  return join(base, 'QQ');
}

/**
 * Candidate data roots in priority order. A user-picked `overrideRoot` (when
 * it exists) wins over the hard-coded `~/.config/QQ`. Deduped.
 */
export function candidateQqRoots(
  home = homedir(),
  overrideRoot?: string | null,
): string[] {
  const roots: string[] = [];
  if (overrideRoot && existsSync(overrideRoot)) roots.push(overrideRoot);
  roots.push(defaultQqDataRoot(home));
  return [...new Set(roots)];
}

/** First data root that exists on disk, or null. */
export function pickQqRoot(home = homedir(), overrideRoot?: string | null): string | null {
  for (const root of candidateQqRoots(home, overrideRoot)) {
    if (existsSync(root)) return root;
  }
  return null;
}

// ---------- account directory (hash of uid) -------------------------------

/**
 * The per-account directory name `nt_qq_<hash>` where
 * `<hash> = md5(md5(uid) + "nt_kernel")`. Pure string derivation — does not
 * touch disk. `uid` is the `u_...` string form, not the numeric uin.
 */
export function accountDirName(uid: string): string {
  const inner = createHash('md5').update(uid, 'utf8').digest('hex');
  const hash = createHash('md5').update(`${inner}nt_kernel`, 'utf8').digest('hex');
  return `nt_qq_${hash}`;
}

/**
 * First `<root>/nt_qq_<hash>/<...segments>` that exists, scanning every
 * candidate root (override-first). Shared by all the `find*` helpers so the
 * uid→dir derivation + override threading live in exactly one place. Returns
 * null when `uid` is empty (we can't derive a dir without it) or nothing
 * exists.
 */
function firstExistingUnderAccount(
  uid: string,
  home: string,
  overrideRoot: string | null | undefined,
  ...segments: string[]
): string | null {
  if (!uid) return null;
  const dir = accountDirName(uid);
  for (const root of candidateQqRoots(home, overrideRoot)) {
    const candidate = join(root, dir, ...segments);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** First `<root>/<...segments>` that exists (root-level, not per-account). */
function firstExistingUnderRoot(
  home: string,
  overrideRoot: string | null | undefined,
  ...segments: string[]
): string | null {
  for (const root of candidateQqRoots(home, overrideRoot)) {
    const candidate = join(root, ...segments);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------- login.db (two locations) --------------------------------------

/**
 * Both login.db paths that exist, in merge-priority order:
 *   1. `<root>/global/nt_db/login.db`        (primary)
 *   2. `<root>/nt_qq/global/nt_db/login.db`  (supplementary)
 * Callers decrypt each and merge, letting earlier entries win on uin clash.
 */
export function findLoginDbs(home = homedir(), overrideRoot?: string | null): string[] {
  const out: string[] = [];
  const primary = firstExistingUnderRoot(home, overrideRoot, 'global', 'nt_db', 'login.db');
  if (primary) out.push(primary);
  const secondary = firstExistingUnderRoot(home, overrideRoot, 'nt_qq', 'global', 'nt_db', 'login.db');
  if (secondary) out.push(secondary);
  return out;
}

/** The primary login.db (`<root>/global/nt_db/login.db`), or the first that exists. */
export function findLoginDb(home = homedir(), overrideRoot?: string | null): string | null {
  return findLoginDbs(home, overrideRoot)[0] ?? null;
}

// ---------- per-account databases (nt_db) ---------------------------------

/** `<root>/nt_qq_<hash>/nt_db/nt_msg.db`. */
export function findNtMsgDb(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_db', 'nt_msg.db');
}

/** `<root>/nt_qq_<hash>/nt_db`. */
export function findNtDbDir(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_db');
}

/** `<root>/nt_qq_<hash>/nt_data` — media data root (Pic/Video/Ptt/File/avatar/…). */
export function findNtDataDir(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_data');
}

/** `<root>/nt_qq_<hash>/nt_db/group_info.db`. */
export function findGroupInfoDb(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_db', 'group_info.db');
}

/** `<root>/nt_qq_<hash>/nt_db/profile_info.db`. */
export function findProfileInfoDb(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_db', 'profile_info.db');
}

/** `<root>/nt_qq_<hash>/nt_db/misc.db`. */
export function findMiscDb(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_db', 'misc.db');
}

/** `<root>/nt_qq_<hash>/nt_db/buddy_msg_fts.db`. */
export function findBuddyMsgFtsDb(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_db', 'buddy_msg_fts.db');
}

/** `<root>/nt_qq_<hash>/nt_db/group_msg_fts.db`. */
export function findGroupMsgFtsDb(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_db', 'group_msg_fts.db');
}

// ---------- per-account resources (nt_data) -------------------------------
// The relative layout under nt_data is identical to win32.

/** `<root>/nt_qq_<hash>/nt_data/Emoji/BaseEmojiSyastems/EmojiSystermResource`. */
export function findEmojiResourceDir(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(
    uid, home, overrideRoot, 'nt_data', 'Emoji', 'BaseEmojiSyastems', 'EmojiSystermResource',
  );
}

/** `<root>/nt_qq_<hash>/nt_data/Emoji/marketface`. */
export function findMarketFaceDir(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_data', 'Emoji', 'marketface');
}

/** `<root>/nt_qq_<hash>/nt_data/Emoji/emoji-recv`. */
export function findEmojiRecvDir(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_data', 'Emoji', 'emoji-recv');
}

/** `<root>/nt_qq_<hash>/nt_data/Emoji/personal_emoji`. */
export function findPersonalEmojiDir(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_data', 'Emoji', 'personal_emoji');
}

/** `<root>/nt_qq_<hash>/nt_data/Emoji/emoji-related/emoji`. */
export function findEmojiRelatedDir(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_data', 'Emoji', 'emoji-related', 'emoji');
}

/** `<root>/nt_qq_<hash>/nt_data/Pic`. */
export function findPicDir(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_data', 'Pic');
}

/** `<root>/nt_qq_<hash>/nt_data/Ptt`. */
export function findPttDir(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_data', 'Ptt');
}

/** `<root>/nt_qq_<hash>/nt_data/Video`. */
export function findVideoDir(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_data', 'Video');
}

/** `<root>/nt_qq_<hash>/nt_data/File`. */
export function findFileDir(uid: string, home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnderAccount(uid, home, overrideRoot, 'nt_data', 'File');
}

// ---------- QQ install (binary / wrapper.node / version) ------------------

/** Candidate QQ binary locations on linux, in priority order. */
export function candidateQqExePaths(): string[] {
  return ['/opt/QQ/qq', '/usr/share/QQ/qq', '/usr/lib/QQ/qq'];
}

/** First QQ binary that exists on disk, or null. No registry on linux. */
export function findQqExe(): string | null {
  for (const p of candidateQqExePaths()) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Given a QQ binary path, its install root (the dir containing it). */
export function qqInstallRoot(qqExePath: string): string {
  return join(qqExePath, '..');
}

/**
 * `<qqRoot>/resources/app/wrapper.node` if it exists. On linux everything
 * lives flat under `resources/app` (no `versions/<x>/` level like win32).
 */
export function findQqWrapperNode(qqExePath: string): string | null {
  const candidate = join(qqExePath, '..', 'resources', 'app', 'wrapper.node');
  return existsSync(candidate) ? candidate : null;
}

/** `<qqRoot>/resources/app/major.node` if it exists (appid/qua anchor). */
export function findQqMajorNode(qqExePath: string): string | null {
  const candidate = join(qqExePath, '..', 'resources', 'app', 'major.node');
  return existsSync(candidate) ? candidate : null;
}

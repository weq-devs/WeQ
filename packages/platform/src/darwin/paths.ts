/**
 * macOS path-resolution helpers — pure functions over the filesystem.
 *
 * QQ NT's storage layout on macOS is byte-for-byte identical to linux:
 *
 *   1. The data root is the sandboxed container path
 *        `~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ`
 *      (the direct analog of linux `~/.config/QQ` — QQ is a sandboxed App Store
 *      build, so all its user data lives under the container, not in
 *      `~/.config`). A user-picked override is still honored as a fallback.
 *
 *   2. The per-account directory is the same hashed name placed DIRECTLY under
 *      the root — `<root>/nt_qq_<hash>/` — with `<hash>` derived from the
 *      account's string `uid` exactly as on linux:
 *
 *        linux:  <root>/nt_qq_<hash>/nt_db/nt_msg.db
 *        macos:  <root>/nt_qq_<hash>/nt_db/nt_msg.db   (same)
 *
 *      Inside the account directory (`nt_db/…`, `nt_data/Emoji/…`, …) the
 *      relative layout is identical too, so the shared root-scanning helpers
 *      from the linux module are reused here with macOS's root list.
 *
 * login.db lives in the SAME two places as linux and both are
 * authoritative-ish:
 *   - `<root>/global/nt_db/login.db`        (primary, larger)
 *   - `<root>/nt_qq/global/nt_db/login.db`  (supplementary, smaller)
 * Callers decrypt both and merge, preferring `global/nt_db`.
 *
 * QQ install (for the launch-based key flows — future work on macOS):
 *   /Applications/QQ.app/Contents/MacOS/QQ      (standard install)
 *   ~/Applications/QQ.app/Contents/MacOS/QQ     (user-level install)
 *   mdfind "kMDItemCFBundleIdentifier == 'com.tencent.qq'" (lazy, cached)
 *   <app>/Contents/Resources/app/wrapper.node   (protobuf descriptors)
 *   <app>/Contents/Resources/app/major.node     (appid/qua anchor)
 *   <app>/Contents/Resources/app/package.json   (client `version`, read
 *                                                uniformly across platforms)
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  accountDirName,
  firstExistingUnderAccountRoots,
  firstExistingUnderRoots,
} from '../linux/paths';

// ---------- data root -----------------------------------------------------

/**
 * Fixed per-user QQ data root on macOS — the sandboxed container path. The
 * `Application Support` segment keeps its literal space (no XDG-style
 * normalization anywhere on this OS).
 */
export function defaultQqDataRoot(home = homedir()): string {
  return join(
    home,
    'Library',
    'Containers',
    'com.tencent.qq',
    'Data',
    'Library',
    'Application Support',
    'QQ',
  );
}

/**
 * Candidate data roots in priority order. A user-picked `overrideRoot` (when
 * it exists) wins over the hard-coded container path. Deduped.
 */
export function candidateQqRoots(home = homedir(), overrideRoot?: string | null): string[] {
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

// ---------- per-account databases / resources (same layout as linux) ------
// The per-account dir name and the relative layout under it are identical to
// linux, so every helper below delegates to the shared root-scanning logic
// with the macOS root list.

function firstUnderAccount(
  uid: string,
  home: string,
  overrideRoot: string | null | undefined,
  ...segments: string[]
): string | null {
  return firstExistingUnderAccountRoots(uid, candidateQqRoots(home, overrideRoot), ...segments);
}

function firstUnderRoot(
  home: string,
  overrideRoot: string | null | undefined,
  ...segments: string[]
): string | null {
  return firstExistingUnderRoots(candidateQqRoots(home, overrideRoot), ...segments);
}

/**
 * Both login.db paths that exist, in merge-priority order:
 *   1. `<root>/global/nt_db/login.db`        (primary)
 *   2. `<root>/nt_qq/global/nt_db/login.db`  (supplementary)
 * Callers decrypt each and merge, letting earlier entries win on uin clash.
 */
export function findLoginDbs(home = homedir(), overrideRoot?: string | null): string[] {
  const out: string[] = [];
  const primary = firstUnderRoot(home, overrideRoot, 'global', 'nt_db', 'login.db');
  if (primary) out.push(primary);
  const secondary = firstUnderRoot(home, overrideRoot, 'nt_qq', 'global', 'nt_db', 'login.db');
  if (secondary) out.push(secondary);
  return out;
}

/** The primary login.db (`<root>/global/nt_db/login.db`), or the first that exists. */
export function findLoginDb(home = homedir(), overrideRoot?: string | null): string | null {
  return findLoginDbs(home, overrideRoot)[0] ?? null;
}

/** `<root>/nt_qq_<hash>` — the account's user-data directory. */
export function findAccountDir(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot);
}

/** `<root>/nt_qq_<hash>/nt_db/nt_msg.db`. */
export function findNtMsgDb(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_db', 'nt_msg.db');
}

/** `<root>/nt_qq_<hash>/nt_db`. */
export function findNtDbDir(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_db');
}

/** `<root>/nt_qq_<hash>/nt_data` — media data root (Pic/Video/Ptt/File/avatar/…). */
export function findNtDataDir(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_data');
}

/** `<root>/nt_qq_<hash>/nt_db/group_info.db`. */
export function findGroupInfoDb(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_db', 'group_info.db');
}

/** `<root>/nt_qq_<hash>/nt_db/profile_info.db`. */
export function findProfileInfoDb(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_db', 'profile_info.db');
}

/** `<root>/nt_qq_<hash>/nt_db/misc.db`. */
export function findMiscDb(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_db', 'misc.db');
}

/** `<root>/nt_qq_<hash>/nt_db/buddy_msg_fts.db`. */
export function findBuddyMsgFtsDb(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_db', 'buddy_msg_fts.db');
}

/** `<root>/nt_qq_<hash>/nt_db/group_msg_fts.db`. */
export function findGroupMsgFtsDb(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_db', 'group_msg_fts.db');
}

/** `<root>/nt_qq_<hash>/nt_data/Emoji/BaseEmojiSyastems/EmojiSystermResource`. */
export function findEmojiResourceDir(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(
    uid,
    home,
    overrideRoot,
    'nt_data',
    'Emoji',
    'BaseEmojiSyastems',
    'EmojiSystermResource',
  );
}

/** `<root>/nt_qq_<hash>/nt_data/Emoji/marketface`. */
export function findMarketFaceDir(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_data', 'Emoji', 'marketface');
}

/** `<root>/nt_qq_<hash>/nt_data/Emoji/emoji-recv`. */
export function findEmojiRecvDir(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_data', 'Emoji', 'emoji-recv');
}

/** `<root>/nt_qq_<hash>/nt_data/Emoji/personal_emoji`. */
export function findPersonalEmojiDir(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_data', 'Emoji', 'personal_emoji');
}

/** `<root>/nt_qq_<hash>/nt_data/Emoji/emoji-related/emoji`. */
export function findEmojiRelatedDir(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_data', 'Emoji', 'emoji-related', 'emoji');
}

/** `<root>/nt_qq_<hash>/nt_data/Pic`. */
export function findPicDir(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_data', 'Pic');
}

/** `<root>/nt_qq_<hash>/nt_data/Ptt`. */
export function findPttDir(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_data', 'Ptt');
}

/** `<root>/nt_qq_<hash>/nt_data/Video`. */
export function findVideoDir(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_data', 'Video');
}

/** `<root>/nt_qq_<hash>/nt_data/File`. */
export function findFileDir(
  uid: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstUnderAccount(uid, home, overrideRoot, 'nt_data', 'File');
}

// ---------- QQ install (app bundle / wrapper.node / version) --------------

/**
 * Candidate QQ executable locations on macOS, in priority order.
 *
 * `WEQ_QQ_EXE` short-circuits the whole list for anything more exotic. The two
 * static candidates cover standard (`/Applications`) and user-level
 * (`~/Applications`) installs. When all miss, {@link findQqExe} falls back to
 * a lazy, cached Spotlight (`mdfind`) query so relocated / non-standard
 * installs are still discovered without paying the ~100ms probe every call.
 */
export function candidateQqExePaths(home = homedir()): string[] {
  const override = process.env.WEQ_QQ_EXE;
  return [
    ...(override ? [override] : []),
    '/Applications/QQ.app/Contents/MacOS/QQ',
    join(home, 'Applications', 'QQ.app', 'Contents', 'MacOS', 'QQ'),
  ];
}

/**
 * Spotlight result cache — `mdfind` is slow (~100ms+) and the answer is
 * stable for a process lifetime, so resolve once and remember (including the
 * negative result, so a miss doesn't re-run the query on every probe).
 */
let spotlightQqExe: string | null | undefined;

/** Locate QQ.app via Spotlight by bundle id; null when unavailable / missing. */
function findQqExeViaSpotlight(): string | null {
  if (spotlightQqExe !== undefined) return spotlightQqExe;
  spotlightQqExe = null;
  try {
    const out = execFileSync('mdfind', ['kMDItemCFBundleIdentifier == "com.tencent.qq"'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const app = out
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (app) {
      const exe = join(app, 'Contents', 'MacOS', 'QQ');
      if (existsSync(exe)) spotlightQqExe = exe;
    }
  } catch {
    /* mdfind unavailable / Spotlight not indexed — fall through */
  }
  return spotlightQqExe;
}

/** First QQ executable that exists on disk (static candidates → Spotlight). */
export function findQqExe(home = homedir()): string | null {
  for (const p of candidateQqExePaths(home)) {
    if (existsSync(p)) return p;
  }
  return findQqExeViaSpotlight();
}

/**
 * `<app>/Contents/Resources/app/wrapper.node` if it exists. macOS ships a
 * flat `resources/app` inside the bundle (no `versions/<x>/` level like
 * win32) — the same layout as linux, but rooted at the bundle's Contents dir.
 */
export function findQqWrapperNode(qqExePath: string): string | null {
  const candidate = join(
    qqExePath,
    '..',
    '..',
    '..',
    'Contents',
    'Resources',
    'app',
    'wrapper.node',
  );
  return existsSync(candidate) ? candidate : null;
}

/** `<app>/Contents/Resources/app/major.node` if it exists (appid/qua anchor). */
export function findQqMajorNode(qqExePath: string): string | null {
  const candidate = join(qqExePath, '..', '..', '..', 'Contents', 'Resources', 'app', 'major.node');
  return existsSync(candidate) ? candidate : null;
}

// Re-export the pure uid→dir-name derivation so the service layer can use the
// same hashing without importing the linux module directly.
export { accountDirName };

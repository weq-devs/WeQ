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
 * Candidate roots in priority order. The caller iterates and checks
 * `existsSync` — we deliberately do NOT pre-filter here, because callers
 * sometimes need to know which roots were tried for error messages.
 *
 * First we trust `UserDataInfo.ini` (the path QQ itself recorded); only if
 * that's unavailable do we fall back to the hard-coded location guesses.
 */
export function candidateTencentFilesRoots(home = homedir()): string[] {
  const roots: string[] = [];
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
  return roots;
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
export function findLoginDb(home = homedir()): string | null {
  for (const root of candidateTencentFilesRoots(home)) {
    const candidate = join(root, 'nt_qq', 'global', 'nt_db', 'login.db');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** `<root>/<uin>/nt_qq/nt_db/nt_msg.db` for the first root that has it. */
export function findNtMsgDb(uin: string, home = homedir()): string | null {
  for (const root of candidateTencentFilesRoots(home)) {
    const candidate = join(root, uin, 'nt_qq', 'nt_db', 'nt_msg.db');
    if (existsSync(candidate)) return candidate;
  }
  return null;
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

/**
 * Win32 path-resolution helpers — pure functions over the filesystem.
 *
 * QQ NT's storage layout:
 *   <TencentFilesRoot>/<uin>/nt_qq/nt_db/nt_msg.db   ← per-account msg db
 *   <TencentFilesRoot>/nt_qq/global/nt_db/login.db   ← global accounts
 *
 * `TencentFilesRoot` can live in several places. `UserDataInfo.ini` records a
 * `UserDataSavePathType` that decides which directory QQ actually uses:
 *   2  → UserDataSavePath（自定义目录，例如换盘 / 重装后指向旧数据）
 *   1  → ~/Documents/Tencent Files
 *   其它（0、3、未知取值、字段缺失）→ ~/Documents/QQ   ← 旧版 QQ 与迁移安装
 * 只有 type=2 时 QQ 才认 savePath；其它类型它会被忽略。但用户手工改 ini
 * 指回旧数据的情况真实存在，所以 savePath 一律保留为候选，只是降级到默认
 * 位置之后，不直接丢掉。
 *
 * Candidate order (override 之外): type 决定的目录 → 其它默认位置 →
 * ~/Tencent Files（便携版）→ ~/<Admin*>/Documents/Tencent Files（旧管理员配置）.
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

/** `[UserDataSet]` 里与根目录有关的两项。 */
export interface UserDataInfo {
  /**
   * `UserDataSavePathType`。QQ 用它决定真正的数据目录：`2` 才认
   * `UserDataSavePath`，`1` 是 `Documents/Tencent Files`，其余取值
   * （0、3、未知、字段缺失）都是旧版布局 `Documents/QQ`。
   */
  savePathType: number | null;
  /** `UserDataSavePath` 原始值（未判断 type）；缺失或为空时 null。 */
  savePath: string | null;
}

/**
 * 读机器级 ini：`<Public>/Documents/Tencent/QQ/UserDataInfo.ini`。
 * `<Public>` 在用户 home 旁边（`C:\Users\Public` 与 `C:\Users\<name>` 同级），
 * 所以用 `dirname(home)/Public` 定位。ini 缺失 / 读不了时返回 null。
 *
 * 只认 `[UserDataSet]` 段，避免误读 `[UserDataImportSet]` 的 `OldVerDataPath`。
 */
export function readUserDataInfo(home = homedir()): UserDataInfo | null {
  const ini = join(dirname(home), 'Public', 'Documents', 'Tencent', 'QQ', 'UserDataInfo.ini');
  let text: string;
  try {
    text = readFileSync(ini, 'utf-8');
  } catch {
    return null;
  }

  const info: UserDataInfo = { savePathType: null, savePath: null };
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
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === 'userdatasavepath') {
      info.savePath = value.length > 0 ? value : null;
    } else if (key === 'userdatasavepathtype') {
      info.savePathType = /^-?\d+$/.test(value) ? Number(value) : null;
    }
  }
  return info;
}

/**
 * `type` 决定的默认数据目录。`type=2` 时就是 `savePath` 本身，所以调用方
 * 需要自己把它拼进候选列表；这里只处理两个固定位置。
 */
function defaultRootForType(home: string, savePathType: number | null): string {
  return savePathType === 1
    ? join(home, 'Documents', 'Tencent Files')
    : join(home, 'Documents', 'QQ');
}

/**
 * QQ 实际认的 Tencent Files 根目录，或 null。
 *
 * 只有 `UserDataSavePathType=2` 时 `UserDataSavePath` 才生效；其它 type 下
 * QQ 直接忽略它。用户手工改 ini 指回旧数据的情况真实存在（例如重装系统后
 * 聊天记录还在 D 盘），所以 {@link candidateTencentFilesRoots} 仍会把
 * savePath 收进候选，只是排在 type 决定的目录之后。
 */
export function tencentFilesRootFromUserDataInfo(home = homedir()): string | null {
  const info = readUserDataInfo(home);
  if (!info) return null;
  return info.savePathType === 2 ? info.savePath : null;
}

/**
 * True when `p` is a per-account data directory rather than the data root:
 *   win32:   `<root>/<uin>`             (`nt_qq/nt_db`, no root-level `nt_qq/global`)
 *   linux/macOS: `<root>/nt_qq_<hash>`
 *
 * The `nt_qq/global` check keeps a data root that happens to be named like an
 * account (`D:\1234`) from being mistaken for one.
 */
function isAccountDataDir(p: string): boolean {
  const base = p.split(/[\\/]/).pop() ?? '';
  if (/^\d+$/.test(base)) {
    // win32 `<root>/<uin>/nt_qq/nt_db`; a root also has `nt_qq/global` beside it.
    return existsSync(join(p, 'nt_qq', 'nt_db')) && !existsSync(join(p, 'nt_qq', 'global'));
  }
  if (/^nt_qq_[0-9a-f]+$/i.test(base)) {
    // linux/macOS `<root>/nt_qq_<hash>/nt_db` — no middle `nt_qq` level.
    return existsSync(join(p, 'nt_db'));
  }
  return false;
}

/**
 * Normalize a user-picked QQ data directory.
 *
 * There is deliberately NO folder-name rule here: QQ lets the user relocate
 * its data directory, and installs migrated from older clients often keep an
 * arbitrary folder name (`D:\QQData`, `E:\备份\QQ`, …). The only correction we
 * make is the common off-by-one pick — the per-account directory itself — which
 * is walked up to its parent (the actual root).
 *
 * Returns the normalized path, which may be the input unchanged.
 */
export function normalizeQqDataRoot(picked: string): string {
  // Keep a bare drive root (`D:\`) intact — stripping its separator would turn
  // it into the drive-relative `D:`, which resolves against the cwd.
  if (/^[A-Za-z]:[\\/]$/.test(picked)) return picked;
  const trimmed = picked.replace(/[\\/]+$/, '');
  if (!trimmed) return picked;
  if (isAccountDataDir(trimmed)) {
    const parent = dirname(trimmed);
    return parent === trimmed ? trimmed : parent;
  }
  return trimmed;
}

/**
 * Candidate roots in priority order. The caller iterates and checks
 * `existsSync` — we deliberately do NOT pre-filter here, because callers
 * sometimes need to know which roots were tried for error messages.
 *
 * A user-picked `overrideRoot` (when it exists on disk) is prepended so it
 * wins over every detected location — this is the single seam that makes the
 * whole platform (login.db decrypt, per-account db lookup, stats) honor a
 * manually-set data directory.
 *
 * 之后按 `UserDataInfo.ini` 的 `UserDataSavePathType` 决定顺序：
 *   - type=2：QQ 认 `UserDataSavePath`，它排第一；
 *   - 其它：QQ 用 `Documents/QQ`（旧版布局），savePath 仅作降级候选，
 *     排在默认位置之后 —— QQ 会忽略它，但用户手改 ini 指回旧数据时仍能兜住。
 */
export function candidateTencentFilesRoots(
  home = homedir(),
  overrideRoot?: string | null,
): string[] {
  const roots: string[] = [];
  if (overrideRoot && existsSync(overrideRoot)) roots.push(overrideRoot);
  const info = readUserDataInfo(home);
  const savePath = info?.savePath ?? null;
  const savePathType = info?.savePathType ?? null;
  if (savePathType === 2 && savePath) roots.push(savePath);
  roots.push(defaultRootForType(home, savePathType));
  // 非 type=2 时 QQ 不用 savePath，但用户可能手工改 ini 指回旧数据 —— 保留兜底。
  if (savePathType !== 2 && savePath) roots.push(savePath);
  roots.push(join(home, 'Tencent Files'));
  // Walk one level deep for `<home>/<Admin*>/Documents/{Tencent Files,QQ}`.
  // Some Windows builds nest the real Documents under a legacy admin profile.
  try {
    for (const entry of readdirSync(home)) {
      if (!entry.toLowerCase().startsWith('admin')) continue;
      roots.push(
        join(home, entry, 'Documents', 'Tencent Files'),
        join(home, entry, 'Documents', 'QQ'),
      );
    }
  } catch {
    /* home unreadable — fall through with the static roots above */
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

/**
 * `<root>/nt_qq/global/nt_data/search/resource_jieba` — QQ's bundled jieba
 * dictionary. It sits under the SHARED `global/` tree (same level as
 * `login.db`), not a per-account `<uin>/nt_qq/nt_data`, so it resolves from
 * the root list directly. Missing is a normal outcome — callers fall back to
 * the built-in segmenter.
 */
export function findJiebaDictDir(home = homedir(), overrideRoot?: string | null): string | null {
  return firstExistingUnder(
    home,
    overrideRoot,
    'nt_qq',
    'global',
    'nt_data',
    'search',
    'resource_jieba',
  );
}

/** `<root>/<uin>` — the account's user-data directory — for the first root that has it. */
export function findAccountDir(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin);
}

/** `<root>/<uin>/nt_qq/nt_db/nt_msg.db` for the first root that has it. */
export function findNtMsgDb(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db', 'nt_msg.db');
}

/** `<root>/<uin>/nt_qq/nt_db` for the first root that has it. */
export function findNtDbDir(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db');
}

/**
 * `<root>/<uin>/nt_qq/nt_data` for the first root that has it — QQ NT's media
 * data root (holds Pic/Video/Ptt/File/avatar/…). Used to place the WeQ 助手
 * avatar file where QQ itself reads it (`nt_data/avatar/weq/…`).
 */
export function findNtDataDir(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data');
}

/** `<root>/<uin>/nt_qq/nt_db/group_info.db` for the first root that has it. */
export function findGroupInfoDb(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db', 'group_info.db');
}

/** `<root>/<uin>/nt_qq/nt_db/profile_info.db` for the first root that has it. */
export function findProfileInfoDb(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db', 'profile_info.db');
}

/** `<root>/<uin>/nt_qq/nt_db/misc.db` for the first root that has it. */
export function findMiscDb(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db', 'misc.db');
}

/**
 * `<root>/<uin>/nt_qq/nt_db/buddy_msg_fts.db` for the first root that has it.
 *
 * QQ's full-text-search index for friends, co-located with `nt_msg.db` in the
 * same `nt_db` folder. Returns null if the account never built a search index.
 */
export function findBuddyMsgFtsDb(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_db', 'buddy_msg_fts.db');
}

/**
 * `<root>/<uin>/nt_qq/nt_db/group_msg_fts.db` for the first root that has it.
 *
 * QQ's full-text-search index for groups, co-located with `nt_msg.db` in the
 * same `nt_db` folder. Returns null if the account never built a search index.
 */
export function findGroupMsgFtsDb(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
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
export function findEmojiResourceDir(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(
    home,
    overrideRoot,
    uin,
    'nt_qq',
    'nt_data',
    'Emoji',
    'BaseEmojiSyastems',
    'EmojiSystermResource',
  );
}

/** `<root>/<uin>/nt_qq/nt_data/Emoji/marketface` for the first root that has it. */
export function findMarketFaceDir(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data', 'Emoji', 'marketface');
}

/**
 * `<root>/<uin>/nt_qq/nt_data/Emoji/emoji-recv` for the first root that has it.
 * Holds received animated emoji (pic subType 1): `<YYYY-MM>/Ori` and `/Thumb`,
 * no separate "original" file.
 */
export function findEmojiRecvDir(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data', 'Emoji', 'emoji-recv');
}

/**
 * `<root>/<uin>/nt_qq/nt_data/Emoji/personal_emoji` for the first root that has
 * it. Holds the user's own / favourited custom emoji as two flat sub-dirs:
 * `Ori/<hash>.<ext>` (original — jpg/gif/png, extension unreliable) and
 * `Thumb/<hash>.png` (still preview).
 */
export function findPersonalEmojiDir(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data', 'Emoji', 'personal_emoji');
}

/**
 * `<root>/<uin>/nt_qq/nt_data/Emoji/emoji-related/emoji` for the first root that
 * has it. Holds keyword-associated emoji: a `words.json` (`{ words: string[] }`)
 * plus one sub-dir per keyword named `md5(keyword)` (UTF-8) containing plaintext
 * `.gif` files. (An `__MACOSX` junk dir may sit beside the hash dirs.)
 */
export function findEmojiRelatedDir(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(
    home,
    overrideRoot,
    uin,
    'nt_qq',
    'nt_data',
    'Emoji',
    'emoji-related',
    'emoji',
  );
}

/** `<root>/<uin>/nt_qq/nt_data/Pic` for the first root that has it. */
export function findPicDir(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data', 'Pic');
}

/** `<root>/<uin>/nt_qq/nt_data/Ptt` for the first root that has it. */
export function findPttDir(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data', 'Ptt');
}

/** `<root>/<uin>/nt_qq/nt_data/Video` for the first root that has it. */
export function findVideoDir(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
  return firstExistingUnder(home, overrideRoot, uin, 'nt_qq', 'nt_data', 'Video');
}

/** `<root>/<uin>/nt_qq/nt_data/File` for the first root that has it. */
export function findFileDir(
  uin: string,
  home = homedir(),
  overrideRoot?: string | null,
): string | null {
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

/** `<qqRoot>/versions/<cur>/resources/app/major.node` if resolvable (appid/qua anchor). */
export function findQqMajorNode(qqRoot: string): string | null {
  const versionDir = resolveQqVersionDir(qqRoot);
  if (!versionDir) return null;
  const candidate = join(versionDir, 'resources', 'app', 'major.node');
  return existsSync(candidate) ? candidate : null;
}

// ---------- QQ install (protocol-handler anchored) ------------------------
//
// The QQNT `tencent://` / `mqqapi://` handler is `timwp.exe`, which sits in
// the SAME `resources/app` directory as `wrapper.node` / `major.node` /
// `package.json`:
//   <qqRoot>/versions/<cur>/resources/app/timwp.exe
// Given that path (resolved by the OS's protocol association, no registry key
// name to guess) every install path the registry lookup computes can be
// derived directly — the version dir is the handler's own grandparent, so
// there's no `versions/config.json` disambiguation either. Each helper
// validates its target exists and returns null otherwise, so callers can fall
// back to the registry path when the handler layout is unexpected.

/** `wrapper.node` next to the protocol handler exe. */
export function findQqWrapperNodeFromProtocolExe(protocolExePath: string): string | null {
  const candidate = join(dirname(protocolExePath), 'wrapper.node');
  return existsSync(candidate) ? candidate : null;
}

/** `major.node` next to the protocol handler exe. */
export function findQqMajorNodeFromProtocolExe(protocolExePath: string): string | null {
  const candidate = join(dirname(protocolExePath), 'major.node');
  return existsSync(candidate) ? candidate : null;
}

/**
 * `QQ.exe` at the install root, four levels up from the handler's `app` dir
 * (`resources/app` → `resources` → `<cur>` → `versions` → `<qqRoot>`).
 */
export function findQqExeFromProtocolExe(protocolExePath: string): string | null {
  const qqRoot = join(dirname(protocolExePath), '..', '..', '..', '..');
  const exe = join(qqRoot, 'QQ.exe');
  return existsSync(exe) ? exe : null;
}

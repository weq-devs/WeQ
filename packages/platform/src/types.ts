/**
 * Platform interface — what every OS adapter must provide.
 *
 * Win32 is the only implementation today; mac/linux will land later. The
 * interface deliberately stays small: it exposes paths + a few QQ probe
 * primitives, then hands the native binding & resources off to higher
 * layers (service package). Path resolution is the only thing that
 * genuinely varies per-OS.
 */

import type { NativeBundle } from '@weq/native';

export interface Platform {
  readonly kind: 'win32' | 'darwin' | 'linux';

  /** Loaded .node bundle + companion resources. */
  readonly native: NativeBundle;

  /**
   * Per-user writable root for weq's own config + cache. On Windows this is
   * `%APPDATA%\weq`. The directory is NOT guaranteed to exist — callers
   * (typically `UserConfigService`) should `mkdir -p` before writing.
   */
  appDataRoot(): string;

  /**
   * Default on-disk directory for the avatar cache. On Windows this is
   * `%APPDATA%\weq\cache\avatar`. Per-OS so the cache lands in the platform's
   * conventional location; the global config may override it. NOT guaranteed
   * to exist — the cache service `mkdir -p`s before writing.
   */
  avatarCacheDir(): string;

  /**
   * Candidate roots that may contain `<uin>/nt_qq/...` directories. Resolved
   * synchronously from well-known locations on this OS — no I/O needed by
   * the caller, just iterate and stat.
   */
  tencentFilesRoots(): string[];

  /**
   * Path to `login.db` (global account list). Returns the first one that
   * exists, or null if none of the candidate roots have it.
   */
  loginDbPath(): string | null;

  /**
   * Resolve `nt_msg.db` for a specific QQ account. Returns null if the dir
   * exists nowhere.
   */
  ntMsgDbPath(uin: string): string | null;

  /**
   * Resolve the account's user-data directory (win32 `<root>/<uin>`, linux
   * `<root>/nt_qq_<hash>`) for a specific account. This is the account root
   * that holds `nt_qq`/`nt_db`/`nt_data` (win32) or `nt_db`/`nt_data` (linux)
   * — the per-OS depth differs, so callers must NOT derive it by walking up
   * from `ntDbDir`. Returns null if the directory exists nowhere.
   */
  accountDir(uin: string): string | null;

  /**
   * Resolve the QQ NT database root (`<Tencent Files>/<uin>/nt_qq/nt_db`) for
   * a specific account. Returns null if the directory exists nowhere.
   */
  ntDbDir(uin: string): string | null;

  /**
   * Resolve QQ NT's media data root (`<Tencent Files>/<uin>/nt_qq/nt_data`) for
   * a specific account — the parent of Pic/Video/Ptt/File/avatar. Returns null
   * if the directory exists nowhere. Used to place the WeQ 助手 avatar image
   * where QQ itself reads it.
   */
  ntDataDir(uin: string): string | null;

  /**
   * Resolve `group_info.db` (group metadata and essence messages) for a
   * specific QQ account. Co-located with `nt_msg.db`.
   */
  groupInfoDbPath(uin: string): string | null;

  /**
   * Resolve `profile_info.db` (buddy list and category info) for a
   * specific QQ account. Co-located with `nt_msg.db`.
   */
  profileInfoDbPath(uin: string): string | null;

  /**
   * Resolve `misc.db` (online status and other metadata) for a specific
   * QQ account. Co-located with `nt_msg.db`.
   */
  miscDbPath(uin: string): string | null;

  /**
   * Resolve `buddy_msg_fts.db` (the full-text-search index for friends) for
   * a specific QQ account. Co-located with `nt_msg.db`. Null if the account
   * has no index.
   */
  buddyMsgFtsDbPath(uin: string): string | null;

  /**
   * Resolve `group_msg_fts.db` (the full-text-search index for groups) for
   * a specific QQ account. Co-located with `nt_msg.db`. Null if the account
   * has no index.
   */
  groupMsgFtsDbPath(uin: string): string | null;

  /**
   * Resolve QQ NT's built-in face resource directory (apng/lottie) for a
   * specific account. The renderer streams emoji from here via `weq-asset://`
   * instead of bundling them into the installer. Null if not found on disk.
   */
  emojiResourceDir(uin: string): string | null;

  /**
   * Resolve QQ NT's market face (store emoji) cache directory for a
   * specific account.
   */
  marketFaceDir(uin: string): string | null;

  /** Received animated-emoji (pic subType 1) cache directory. */
  emojiRecvDir(uin: string): string | null;

  /** Personal / favourited custom-emoji cache directory (`…/Emoji/personal_emoji`). */
  personalEmojiDir(uin: string): string | null;

  /** Related-emoji (keyword → gif) cache directory (`…/Emoji/emoji-related/emoji`). */
  emojiRelatedDir(uin: string): string | null;

  /** Resolve QQ NT's picture data directory. */
  picDir(uin: string): string | null;
  /** Resolve QQ NT's PTT (voice message) data directory. */
  pttDir(uin: string): string | null;
  /** Resolve QQ NT's video data directory. */
  videoDir(uin: string): string | null;
  /** Resolve QQ NT's file data directory. */
  fileDir(uin: string): string | null;

  /**
   * Absolute path to a currently installed QQ.exe (or platform equivalent).
   * Used by the launch-based key flows (QR / quick login). Null if QQ isn't
   * installed at any known location.
   */
  qqExePath(): string | null;

  /**
   * Path to `wrapper.node` inside QQ's resources/app. The `protocol` layer
   * inside `nt_helper` needs this to read protobuf descriptors at runtime.
   */
  qqWrapperNodePath(): string | null;

  /**
   * Path to `major.node` inside QQ's resources/app — the anchor
   * `resolveAppidFromMajor` scans for the build's appid/qua. Co-located with
   * `wrapper.node`. Null if QQ isn't found. The appid/qua MUST match the
   * installed build or the login server rejects with 140022017.
   */
  qqMajorNodePath(): string | null;

  /**
   * The installed QQ client version (e.g. `3.2.31-51102`), read from the
   * `package.json` co-located with `wrapper.node`. Uniform across win32/linux
   * — unlike scraping it from the on-disk path, which only matches win32's
   * `versions/<ver>/` layout. Null if QQ isn't found or the file is unusable.
   */
  qqVersion(): string | null;

  /**
   * Is the given QQ account currently logged in on this machine? Wraps the
   * native probe, supplying the per-OS identifying inputs the mechanism needs
   * (win32 keys off `uin`; linux/macOS need the data-root `baseDir` + string
   * `uid`, derived here so callers never assemble OS-specific paths). Returns
   * false if the probe is unavailable or the inputs can't be resolved.
   */
  isQqLoggedIn(uin: string): boolean;

  /**
   * Number of online QQ instances as QQ itself records it, or null when this
   * OS has no such authoritative source (callers then fall back to the native
   * process-count probe). On linux this reads `versions/setting.json`'s
   * `launcherCounts`; win32 returns null.
   */
  launcherCount(): number | null;
}

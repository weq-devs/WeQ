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
}

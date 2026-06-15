/**
 * Normalized account model shared by the bootstrap login panel + selector.
 *
 * Both flows ("现有配置" / "新的开始") funnel into one `UiAccount` shape so
 * the selector and login panel don't branch on source. Mode-specific fields
 * are optional and only present where meaningful.
 */

import type { DatabaseAlgorithms } from '@weq/native';

export interface UiAccount {
  /** Stable list key: configId (existing) or uin (new). */
  key: string;
  uin: string;
  /** Nickname, or the uin when no nickname is known. */
  name: string;
  /** Whether a real nickname was resolved (drives bold-uin fallback styling). */
  hasName: boolean;
  avatarUrl: string | null;

  // ---- existing-config mode ----
  configId?: string;
  dbKey?: string;
  algo?: DatabaseAlgorithms;
  dataDir?: string;
  lastLoginAt?: number;

  // ---- new-start mode ----
  /** Non-empty marker ⇒ account is quick-login-able. */
  a1Key?: string;
}

/** Derive an account's `nt_msg.db` path from the Tencent Files root. */
export function deriveMsgDbPath(root: string, uin: string): string {
  return `${root}\\${uin}\\nt_qq\\nt_db\\nt_msg.db`;
}

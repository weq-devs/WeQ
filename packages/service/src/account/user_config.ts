/**
 * AccountConfigService — manages per-account persistent configuration.
 *
 * Saves credentials (uin, dbKey, algo) plus display metadata (nickname,
 * avatar) to a local file so the user can "现有配置" next time without
 * re-detecting / re-scanning.
 *
 * Identity model: the PRIMARY KEY is the account's user-data directory
 * (`…\Tencent Files\<uin>`), NOT the uin. The same uin opened from two
 * different data directories is two independent records — otherwise a
 * future "decrypt backup database" step would collide. The on-disk file
 * name is derived from (uin + dataDir) via {@link accountConfigId}.
 *
 * Path: <appDataRoot>/config/accounts/<configId>.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { DatabaseAlgorithms } from '@weq/native';

export interface AccountConfig {
  /**
   * Stable record id derived from (uin, dataDir). Filename is
   * `<configId>.json`. Older configs written before this field existed fall
   * back to `uin` at read time.
   */
  configId: string;
  uin: string;
  dbKey: string;
  algo: DatabaseAlgorithms;
  /**
   * Absolute path to this account's user-data directory
   * (`…\Tencent Files\<uin>`). The true primary key; same uin + different
   * dataDir ⇒ separate record.
   */
  dataDir?: string;
  /** Last seen display name / nickname (for the picker). */
  displayName?: string;
  /** Cached avatar URL (for the picker), if resolved. */
  avatarUrl?: string;
  /** Unix milliseconds of last login. */
  lastLoginAt: number;
}

/** Metadata threaded in from the open flow to enrich the saved record. */
export interface AccountConfigMetadata {
  displayName?: string;
  avatarUrl?: string;
  dataDir?: string;
}

/**
 * Stable, filesystem-safe id for an account record. Uses the uin as a
 * human-readable prefix and a short hash of the data directory as the
 * disambiguator so the same uin opened from two dirs maps to two files.
 *
 * When `dataDir` is absent we fall back to the bare uin — keeps the common
 * single-directory case tidy and back-compatible with legacy `<uin>.json`.
 */
export function accountConfigId(uin: string, dataDir?: string | null): string {
  if (!dataDir) return uin;
  return `${uin}_${shortHash(dataDir)}`;
}

/** djb2 → 8-char hex. Not cryptographic — just a stable directory tag. */
function shortHash(input: string): string {
  let h = 5381;
  const normalized = input.trim().toLowerCase();
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h + normalized.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export class AccountConfigService {
  private readonly accountsDir: string;

  constructor(
    private readonly session: AccountSession,
    appDataRoot: string,
  ) {
    this.accountsDir = join(appDataRoot, 'config', 'accounts');
  }

  /**
   * Save the current session's credentials + metadata to disk, keyed by the
   * account's data directory (see {@link accountConfigId}).
   */
  save(metadata: AccountConfigMetadata = {}): void {
    const uin = this.session.context.uin;
    const configId = accountConfigId(uin, metadata.dataDir);
    const config: AccountConfig = {
      configId,
      uin,
      dbKey: this.session.context.dbKey,
      algo: this.session.context.algo,
      ...(metadata.dataDir ? { dataDir: metadata.dataDir } : {}),
      ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
      ...(metadata.avatarUrl ? { avatarUrl: metadata.avatarUrl } : {}),
      lastLoginAt: Date.now(),
    };

    mkdirSync(this.accountsDir, { recursive: true });
    const filePath = join(this.accountsDir, `${configId}.json`);
    writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  }
}

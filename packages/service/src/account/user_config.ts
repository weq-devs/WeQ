/**
 * AccountConfigService — manages per-account persistent configuration.
 *
 * Saves credentials (uin, dbKey) and metadata to a local file so the user
 * can "Quick Start" next time without re-scanning or re-detecting.
 *
 * Path: <appDataRoot>/config/accounts/<uin>.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';

export interface AccountConfig {
  uin: string;
  dbKey: string;
  /** Last seen display name or nickname. */
  displayName?: string;
  /** Unix timestamp of last login. */
  lastLoginAt: number;
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
   * Save the current session's credentials to disk.
   */
  save(metadata: { displayName?: string } = {}): void {
    const config: AccountConfig = {
      uin: this.session.context.uin,
      dbKey: this.session.context.dbKey,
      displayName: metadata.displayName,
      lastLoginAt: Date.now(),
    };

    mkdirSync(this.accountsDir, { recursive: true });
    const filePath = join(this.accountsDir, `${config.uin}.json`);
    writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  }
}

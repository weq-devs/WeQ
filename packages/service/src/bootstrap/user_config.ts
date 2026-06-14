/**
 * UserConfigService — global, app-wide preferences (single instance).
 *
 * Not per-account. weq is a database viewer, so "switch account" should
 * not change the UI's theme / port / etc. Per-account preference would
 * just confuse the user.
 *
 * Storage layout (under `platform.appDataRoot()`, win32=%APPDATA%/weq):
 *
 *   <root>/config.json     ← preferences (this service owns it)
 *   <root>/cache/<cat>/    ← arbitrary on-disk cache (avatar/preview/…)
 *
 * Callers that need to write cached files (avatars, image previews,
 * generated reports) call `cacheDir(category)` and get back an absolute
 * path with the directory already `mkdir -p`'d. The service does NOT
 * track those files — TTL / pruning belongs in whoever wrote them.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import type { AccountConfig } from '../account/user_config';

/**
 * Schema for `config.json`. Empty today — additions like `theme`,
 * `lastUsedUin`, `apiPort`, `authToken` go here. All fields are optional
 * so older config files keep loading after a schema bump.
 */
export interface UserConfig {
  // Reserved for future settings — kept open so older files still load.
}

export class UserConfigService {
  private readonly root: string;
  private readonly configPath: string;
  private cached: UserConfig | undefined;

  constructor(platform: Platform) {
    this.root = platform.appDataRoot();
    this.configPath = join(this.root, 'config.json');
  }

  /**
   * List all saved account configurations from <root>/config/accounts/*.json.
   */
  listAccountConfigs(): AccountConfig[] {
    const dir = join(this.root, 'config', 'accounts');
    try {
      const files = readdirSync(dir);
      const configs: AccountConfig[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = readFileSync(join(dir, file), 'utf-8');
          configs.push(JSON.parse(raw) as AccountConfig);
        } catch {
          /* skip corrupt files */
        }
      }
      return configs.sort((a, b) => b.lastLoginAt - a.lastLoginAt);
    } catch {
      return [];
    }
  }

  /**
   * Delete a saved account configuration.
   */
  deleteAccountConfig(uin: string): void {
    const filePath = join(this.root, 'config', 'accounts', `${uin}.json`);
    try {
      unlinkSync(filePath);
    } catch {
      /* ignore if file doesn't exist */
    }
  }

  /**
   * Read the current config from disk. Missing file → returns `{}` and
   * remembers the empty result so subsequent calls don't keep stat'ing.
   * Use `reload()` if an external editor changed the file.
   */
  read(): UserConfig {
    if (this.cached) return this.cached;
    let raw: string;
    try {
      raw = readFileSync(this.configPath, 'utf-8');
    } catch {
      this.cached = {};
      return this.cached;
    }
    try {
      this.cached = JSON.parse(raw) as UserConfig;
    } catch {
      // Corrupt file — fall back to empty rather than crash the bootstrap.
      // The first `write()` will overwrite the bad bytes.
      this.cached = {};
    }
    return this.cached;
  }

  /** Drop the in-memory cache; the next `read()` will hit disk again. */
  reload(): void {
    this.cached = undefined;
  }

  /**
   * Shallow-merge `patch` into the current config and persist atomically.
   * Returns the new full config.
   */
  write(patch: Partial<UserConfig>): UserConfig {
    const current = this.read();
    const next: UserConfig = { ...current, ...patch };
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(next, null, 2), 'utf-8');
    this.cached = next;
    return next;
  }

  /**
   * Absolute path to `<root>/cache/<category>/`, created if missing.
   *
   * `category` is a free-form short identifier ("avatar", "preview",
   * "report-2026"). No validation here — the caller picks meaningful
   * names; bad input just creates an oddly-named directory.
   */
  cacheDir(category: string): string {
    const dir = join(this.root, 'cache', category);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

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
import { join, basename } from 'node:path';
import type { Platform } from '@weq/platform';
import type { AccountConfig } from '../account/user_config';

/**
 * Cached QQ-installation probe. Written by {@link GlobalConfigService} after
 * a successful detect so subsequent launches skip the (registry + fs) scan;
 * each field is re-validated on read and the whole block re-probed if a path
 * has gone stale.
 */
export interface InstallCache {
  qqExePath: string | null;
  wrapperNodePath: string | null;
  loginDbPath: string | null;
  /** The single in-use Tencent Files root. */
  tencentFilesRoot: string | null;
  /** QQ client version parsed from the wrapper.node path (e.g. `9.9.28-46928`). */
  version: string | null;
  /** Same as `tencentFilesRoot` — kept under the spec's name for clarity. */
  userDataPath: string | null;
  /** Unix ms the probe was taken. */
  probedAt: number;
}

/**
 * "Auto-enter this account next launch". Global — exactly one target at a
 * time; checking the box for another account overwrites this. Keyed by the
 * account record's {@link AccountConfig.configId}.
 */
export interface AutoEnterTarget {
  configId: string;
  uin: string;
  dataDir?: string;
}

/** Recursive `Partial` — lets persisted `settings` omit any nested field. */
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * "自动从登录的 QQ 进程获取 rkey 补全缺失媒体" settings. This is what powers
 * both in-app media viewing and export completion — see {@link MediaDownloadService}.
 */
export interface MediaCompletionConfig {
  /** Master switch: harvest rkeys from the online QQ and use them to complete media. */
  enabled: boolean;
}

/**
 * 语音转录 settings. Holds the selected model id (matches an entry in
 * {@link VOICE_MODELS}). Empty string = feature off (no model chosen), which is
 * what gates the 转文字 button in the chat view.
 */
export interface VoiceTranscribeConfig {
  /** Selected transcription model id, or '' when none is chosen. */
  modelId: string;
}

/**
 * Global, app-wide preferences exposed in the 设置 → 基础配置 page. Lives under
 * the `settings` key in `config.json`. All read paths merge against
 * {@link DEFAULT_APP_SETTINGS} so an older / partial file still yields a full,
 * well-typed object.
 */
export interface AppSettings {
  /** 启用数据库监听（实时消息）. Drives whether the nt_msg.db watcher is mounted. */
  realtimeEnabled: boolean;
  /** 媒体补全（rkey）配置. */
  mediaCompletion: MediaCompletionConfig;
  /** 自动获取 ClientKey. */
  autoFetchClientKey: boolean;
  /** 语音转录（选中的模型）. */
  voiceTranscribe: VoiceTranscribeConfig;
}

/** Defaults applied when a field is absent from `config.json`. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  realtimeEnabled: true,
  mediaCompletion: { enabled: true },
  autoFetchClientKey: true,
  voiceTranscribe: { modelId: '' },
};

/**
 * Schema for `config.json`. All fields optional so older files keep loading
 * after a schema bump.
 */
export interface UserConfig {
  /** Cached QQ-installation probe (see {@link InstallCache}). */
  install?: InstallCache;
  /** Account to silently re-enter on next launch, or null/absent for none. */
  autoEnter?: AutoEnterTarget | null;
  /** User-picked Tencent Files root override (from the folder dialog). */
  tencentFilesRootOverride?: string | null;
  /**
   * Override for the avatar cache directory. Absent → the cache service uses
   * `platform.avatarCacheDir()` (the per-OS default). Set this to relocate the
   * cache (e.g. onto a larger drive).
   */
  avatarCacheDir?: string | null;
  /**
   * Global app settings (设置 → 基础配置). Stored partial; read through
   * {@link UserConfigService.getSettings} which merges {@link DEFAULT_APP_SETTINGS}.
   */
  settings?: DeepPartial<AppSettings>;
  /**
   * Custom cache directory root (设置 → 账号信息 → 账号缓存路径). Absent → the
   * default `<appDataRoot>/cache`. Routes {@link UserConfigService.cacheDir}
   * (and thus the media download cache) onto another disk.
   */
  cacheDirOverride?: string | null;
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
          const parsed = JSON.parse(raw) as AccountConfig;
          // Back-compat: legacy `<uin>.json` records lack `configId` — derive
          // it from the filename so the rest of the app can key on it.
          if (!parsed.configId) parsed.configId = basename(file, '.json');
          configs.push(parsed);
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
   * Delete a saved account configuration by its record id (filename stem).
   */
  deleteAccountConfig(configId: string): void {
    const filePath = join(this.root, 'config', 'accounts', `${configId}.json`);
    try {
      unlinkSync(filePath);
    } catch {
      /* ignore if file doesn't exist */
    }
    // If the deleted record was the auto-enter target, clear it too.
    const cfg = this.read();
    if (cfg.autoEnter && cfg.autoEnter.configId === configId) {
      this.write({ autoEnter: null });
    }
  }

  // ---- auto-enter target (global, single) ----

  /** The account to silently re-enter on next launch, or null. */
  getAutoEnter(): AutoEnterTarget | null {
    return this.read().autoEnter ?? null;
  }

  /** Set (overwrite) the single auto-enter target. */
  setAutoEnter(target: AutoEnterTarget): void {
    this.write({ autoEnter: target });
  }

  /** Clear the auto-enter target. */
  clearAutoEnter(): void {
    this.write({ autoEnter: null });
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
   * Absolute path to `<cacheBase>/<category>/`, created if missing.
   *
   * `category` is a free-form short identifier ("avatar", "preview",
   * "report-2026"). No validation here — the caller picks meaningful
   * names; bad input just creates an oddly-named directory. The base honours
   * {@link UserConfig.cacheDirOverride} (see {@link cacheBaseDir}).
   */
  cacheDir(category: string): string {
    const dir = join(this.cacheBaseDir(), category);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ---- app settings (global, 设置 → 基础配置) ----

  /**
   * Full, defaulted app settings. Always returns every field — missing keys in
   * `config.json` fall back to {@link DEFAULT_APP_SETTINGS}.
   */
  getSettings(): AppSettings {
    const s = this.read().settings;
    const d = DEFAULT_APP_SETTINGS;
    return {
      realtimeEnabled: s?.realtimeEnabled ?? d.realtimeEnabled,
      autoFetchClientKey: s?.autoFetchClientKey ?? d.autoFetchClientKey,
      mediaCompletion: {
        enabled: s?.mediaCompletion?.enabled ?? d.mediaCompletion.enabled,
      },
      voiceTranscribe: {
        modelId: s?.voiceTranscribe?.modelId ?? d.voiceTranscribe.modelId,
      },
    };
  }

  /**
   * Deep-merge `patch` into the current settings and persist. Returns the new
   * full settings object.
   */
  setSettings(patch: DeepPartial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = {
      realtimeEnabled: patch.realtimeEnabled ?? current.realtimeEnabled,
      autoFetchClientKey: patch.autoFetchClientKey ?? current.autoFetchClientKey,
      mediaCompletion: {
        enabled: patch.mediaCompletion?.enabled ?? current.mediaCompletion.enabled,
      },
      voiceTranscribe: {
        modelId: patch.voiceTranscribe?.modelId ?? current.voiceTranscribe.modelId,
      },
    };
    this.write({ settings: next });
    return next;
  }

  // ---- cache directory (设置 → 账号信息 → 账号缓存路径) ----

  /** Default cache base when no override is set. */
  private defaultCacheBase(): string {
    return join(this.root, 'cache');
  }

  /** Effective cache base: the override if set & non-blank, else the default. */
  cacheBaseDir(): string {
    const o = this.read().cacheDirOverride;
    return o && o.trim() ? o : this.defaultCacheBase();
  }

  /** Effective / override / default cache paths, for display in settings. */
  getCacheDirInfo(): { effective: string; override: string | null; default: string } {
    const def = this.defaultCacheBase();
    const o = this.read().cacheDirOverride ?? null;
    return { effective: o && o.trim() ? o : def, override: o, default: def };
  }

  /** Set (or clear with null/blank) the custom cache directory override. */
  setCacheDirOverride(dir: string | null): void {
    this.write({ cacheDirOverride: dir && dir.trim() ? dir : null });
  }
}

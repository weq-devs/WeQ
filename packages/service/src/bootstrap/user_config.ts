/**
 * UserConfigService — global, app-wide preferences (single instance).
 *
 * Not per-account. weq is a database viewer, so "switch account" should
 * not change the UI's theme / port / etc. Per-account preference would
 * just confuse the user.
 *
 * Storage layout (under `platform.appDataRoot()`, win32=%APPDATA%/weq):
 *
 *   <root>/config.json     -> preferences (this service owns it)
 *   <root>/cache/<cat>/    -> arbitrary on-disk cache (avatar/preview/...)
 *
 * Callers that need to write cached files (avatars, image previews,
 * generated reports) call `cacheDir(category)` and get back an absolute
 * path with the directory already `mkdir -p`'d. The service does NOT
 * track those files — TTL / pruning belongs in whoever wrote them.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Platform } from '@weq/platform';
import type { AgentLabProviderConfig } from '@weq/agentlab';
import type { TtsProviderConfig } from '../common/tts';
import type { AccountConfig } from '../account/user_config';
import { getLogger, logErrorContext } from '../common/logger';

export interface InstallCache {
  qqExePath: string | null;
  wrapperNodePath: string | null;
  loginDbPath: string | null;
  tencentFilesRoot: string | null;
  version: string | null;
  userDataPath: string | null;
  probedAt: number;
}

export interface AutoEnterTarget {
  configId: string;
  uin: string;
  dataDir?: string;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function isAgentLabProviderConfig(value: unknown): value is AgentLabProviderConfig {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AgentLabProviderConfig>;
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.vendor === 'string' &&
    typeof item.baseUrl === 'string' &&
    typeof item.apiKey === 'string' &&
    Array.isArray(item.models) &&
    typeof item.createdAt === 'number' &&
    typeof item.updatedAt === 'number'
  );
}

function normalizeAgentLabProviders(value: unknown): AgentLabProviderConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isAgentLabProviderConfig);
}

/** Coerce a persisted / patched close-behavior value to the known union, or
 *  `undefined` so the caller falls back to the default / current value. */
function normalizeWindowCloseBehavior(value: unknown): WindowCloseBehavior | undefined {
  return value === 'ask' || value === 'tray' || value === 'quit' ? value : undefined;
}

function isTtsProviderConfig(value: unknown): value is TtsProviderConfig {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TtsProviderConfig>;
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.vendor === 'string' &&
    typeof item.baseUrl === 'string' &&
    typeof item.apiKey === 'string' &&
    typeof item.createdAt === 'number' &&
    typeof item.updatedAt === 'number'
  );
}

function normalizeTtsProviders(value: unknown): TtsProviderConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isTtsProviderConfig);
}

export interface MediaCompletionConfig {
  enabled: boolean;
}

export interface VoiceTranscribeConfig {
  /** 离线转录模型 id（空 = 关）。 */
  modelId: string;
  /** TTS 服务商列表（用于克隆体发语音/语音克隆）。 */
  ttsProviders: TtsProviderConfig[];
}

/**
 * Local MCP server config. The server is account-bound — it only listens while
 * an account is open and stops when the account switches / logs out. Bound to
 * 127.0.0.1 and gated by a bearer `token` (generated on first enable).
 */
export interface McpServerConfig {
  enabled: boolean;
  port: number;
  token: string;
}

export interface AgentLabSettings {
  providers: AgentLabProviderConfig[];
}

/**
 * 关闭主窗口（标题栏 ✕）时的行为：
 *   - 'ask'  首次询问，弹窗让用户选择（最小化到托盘 / 完全退出），可记住选择
 *   - 'tray' 最小化到系统托盘，进程常驻后台，可从托盘恢复
 *   - 'quit' 直接完全退出应用
 */
export type WindowCloseBehavior = 'ask' | 'tray' | 'quit';

export interface AppSettings {
  realtimeEnabled: boolean;
  mediaCompletion: MediaCompletionConfig;
  autoFetchClientKey: boolean;
  /**
   * 空闲自动上锁阈值（分钟）。0 = 关闭自动上锁（仍可在左栏手动上锁）。
   * 解锁强制走系统认证（Windows Hello / Touch ID），无绕过入口。
   */
  autoLockMinutes: number;
  voiceTranscribe: VoiceTranscribeConfig;
  mcp: McpServerConfig;
  agentLab: AgentLabSettings;
  /** 点击关闭按钮时的行为。默认 'ask'（首次弹窗询问）。 */
  windowCloseBehavior: WindowCloseBehavior;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  realtimeEnabled: true,
  mediaCompletion: { enabled: true },
  autoFetchClientKey: true,
  autoLockMinutes: 0,
  voiceTranscribe: { modelId: '', ttsProviders: [] },
  // 8765 在 Windows 上常被百度输入法等占用，默认改用不常冲突的高端口；
  // 即便仍冲突，启动时也会自动向上探测可用端口（见 mcp/server.ts）。
  mcp: { enabled: false, port: 48765, token: '' },
  agentLab: { providers: [] },
  windowCloseBehavior: 'ask',
};

export interface UserConfig {
  install?: InstallCache;
  autoEnter?: AutoEnterTarget | null;
  tencentFilesRootOverride?: string | null;
  avatarCacheDir?: string | null;
  settings?: DeepPartial<AppSettings>;
  cacheDirOverride?: string | null;
  welcomeAcknowledged?: boolean;
}

export class UserConfigService {
  private readonly root: string;
  private readonly configPath: string;
  private cached: UserConfig | undefined;
  private readonly logger = getLogger().child({ scope: 'user-config' });

  constructor(platform: Platform) {
    this.root = platform.appDataRoot();
    this.configPath = join(this.root, 'config.json');
  }

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
          if (!parsed.configId) parsed.configId = basename(file, '.json');
          configs.push(parsed);
        } catch (error) {
          this.logger.warn('skipped invalid account config file', {
            event: 'list-account-configs-skip',
            file,
            ...logErrorContext(error),
          });
        }
      }
      return configs.sort((a, b) => b.lastLoginAt - a.lastLoginAt);
    } catch {
      return [];
    }
  }

  deleteAccountConfig(configId: string): void {
    const filePath = join(this.root, 'config', 'accounts', `${configId}.json`);
    try {
      unlinkSync(filePath);
      this.logger.info('deleted account config', { event: 'delete-account-config', configId, filePath });
    } catch {
      /* ignore if file doesn't exist */
    }
    const cfg = this.read();
    if (cfg.autoEnter && cfg.autoEnter.configId === configId) {
      this.write({ autoEnter: null });
    }
  }

  getAutoEnter(): AutoEnterTarget | null {
    return this.read().autoEnter ?? null;
  }

  setAutoEnter(target: AutoEnterTarget): void {
    this.write({ autoEnter: target });
    this.logger.info('updated auto-enter target', {
      event: 'set-auto-enter',
      configId: target.configId,
      accountUin: target.uin,
      dataDir: target.dataDir ?? null,
    });
  }

  clearAutoEnter(): void {
    this.write({ autoEnter: null });
    this.logger.info('cleared auto-enter target', { event: 'clear-auto-enter' });
  }

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
    } catch (error) {
      this.logger.warn('failed to parse config.json; using empty config', {
        event: 'config-parse-failed',
        configPath: this.configPath,
        ...logErrorContext(error),
      });
      this.cached = {};
    }
    return this.cached;
  }

  reload(): void {
    this.cached = undefined;
  }

  write(patch: Partial<UserConfig>): UserConfig {
    const current = this.read();
    const next: UserConfig = { ...current, ...patch };
    mkdirSync(this.root, { recursive: true });
    try {
      writeFileSync(this.configPath, JSON.stringify(next, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('failed to write user config', {
        event: 'config-write-failed',
        configPath: this.configPath,
        patchKeys: Object.keys(patch),
        ...logErrorContext(error),
      });
      throw error;
    }
    this.cached = next;
    this.logger.info('wrote user config', {
      event: 'config-write',
      configPath: this.configPath,
      patchKeys: Object.keys(patch),
    });
    return next;
  }

  cacheDir(category: string): string {
    const dir = join(this.cacheBaseDir(), category);
    mkdirSync(dir, { recursive: true });
    this.logger.debug('ensured cache directory', { event: 'cache-dir', category, dir });
    return dir;
  }

  getSettings(): AppSettings {
    const s = this.read().settings;
    const d = DEFAULT_APP_SETTINGS;
    return {
      realtimeEnabled: s?.realtimeEnabled ?? d.realtimeEnabled,
      autoFetchClientKey: s?.autoFetchClientKey ?? d.autoFetchClientKey,
      autoLockMinutes: s?.autoLockMinutes ?? d.autoLockMinutes,
      windowCloseBehavior: normalizeWindowCloseBehavior(s?.windowCloseBehavior) ?? d.windowCloseBehavior,
      mediaCompletion: {
        enabled: s?.mediaCompletion?.enabled ?? d.mediaCompletion.enabled,
      },
      voiceTranscribe: {
        modelId: s?.voiceTranscribe?.modelId ?? d.voiceTranscribe.modelId,
        ttsProviders: normalizeTtsProviders(s?.voiceTranscribe?.ttsProviders) ?? d.voiceTranscribe.ttsProviders,
      },
      mcp: {
        enabled: s?.mcp?.enabled ?? d.mcp.enabled,
        port: s?.mcp?.port ?? d.mcp.port,
        token: s?.mcp?.token ?? d.mcp.token,
      },
      agentLab: {
        providers: normalizeAgentLabProviders(s?.agentLab?.providers) ?? d.agentLab.providers,
      },
    };
  }

  setSettings(patch: DeepPartial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = {
      realtimeEnabled: patch.realtimeEnabled ?? current.realtimeEnabled,
      autoFetchClientKey: patch.autoFetchClientKey ?? current.autoFetchClientKey,
      autoLockMinutes: patch.autoLockMinutes ?? current.autoLockMinutes,
      windowCloseBehavior:
        normalizeWindowCloseBehavior(patch.windowCloseBehavior) ?? current.windowCloseBehavior,
      mediaCompletion: {
        enabled: patch.mediaCompletion?.enabled ?? current.mediaCompletion.enabled,
      },
      voiceTranscribe: {
        modelId: patch.voiceTranscribe?.modelId ?? current.voiceTranscribe.modelId,
        ttsProviders:
          patch.voiceTranscribe?.ttsProviders !== undefined
            ? normalizeTtsProviders(patch.voiceTranscribe.ttsProviders)
            : current.voiceTranscribe.ttsProviders,
      },
      mcp: {
        enabled: patch.mcp?.enabled ?? current.mcp.enabled,
        port: patch.mcp?.port ?? current.mcp.port,
        token: patch.mcp?.token ?? current.mcp.token,
      },
      agentLab: {
        providers:
          patch.agentLab?.providers !== undefined
            ? normalizeAgentLabProviders(patch.agentLab.providers)
            : current.agentLab.providers,
      },
    };
    this.write({ settings: next });
    this.logger.info('updated app settings', {
      event: 'set-settings',
      patchKeys: Object.keys(patch),
      realtimeEnabled: next.realtimeEnabled,
      autoFetchClientKey: next.autoFetchClientKey,
      autoLockMinutes: next.autoLockMinutes,
      mediaCompletionEnabled: next.mediaCompletion.enabled,
      voiceModelId: next.voiceTranscribe.modelId,
      ttsProviderCount: next.voiceTranscribe.ttsProviders.length,
      mcpEnabled: next.mcp.enabled,
      mcpPort: next.mcp.port,
      agentLabProviderCount: next.agentLab.providers.length,
    });
    return next;
  }

  isWelcomeAcknowledged(): boolean {
    return this.read().welcomeAcknowledged === true;
  }

  acknowledgeWelcome(): void {
    this.write({ welcomeAcknowledged: true });
    this.logger.info('welcome dialog acknowledged', { event: 'welcome-ack' });
  }

  private defaultCacheBase(): string {
    return join(this.root, 'cache');
  }

  cacheBaseDir(): string {
    const o = this.read().cacheDirOverride;
    return o && o.trim() ? o : this.defaultCacheBase();
  }

  getCacheDirInfo(): { effective: string; override: string | null; default: string } {
    const def = this.defaultCacheBase();
    const o = this.read().cacheDirOverride ?? null;
    return { effective: o && o.trim() ? o : def, override: o, default: def };
  }

  setCacheDirOverride(dir: string | null): void {
    this.write({ cacheDirOverride: dir && dir.trim() ? dir : null });
    this.logger.info('updated cache directory override', {
      event: 'set-cache-dir-override',
      dir: dir && dir.trim() ? dir : null,
    });
  }
}

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

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  statSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import type { Platform } from '@weq/platform';
import type { AgentLabProviderConfig, TtsProviderConfig } from '@weq/agentlab';
import type { AccountConfig } from '../account/user_config';
import { generateWeqAssistantUid } from '../account/weq_assistant';
import { getLogger, logErrorContext } from '../common/logger';

export interface AutoEnterTarget {
  configId: string;
  uin: string;
  dataDir?: string;
}

/**
 * A persisted "this pid is already hook-injected" record (linux only).
 *
 * The linux inject is expensive: a pkexec/polkit password dialog + an exclusive
 * ptrace attach. The in-memory injectHook caches which pids are injected, but a
 * WeQ restart loses that — so without persistence WeQ would re-inject an
 * already-hooked, still-running QQ (popping the password dialog again and racing
 * the hook's control pipe). We persist the record here keyed by pid and prune it
 * when the pid is gone (see {@link UserConfigService.pruneInjectRecords}).
 *
 * `startTime` is the process start time (jiffies from `/proc/<pid>/stat`) taken
 * at inject time. pids are recycled by the kernel, so on reuse we compare the
 * live start time against this one; a mismatch means "different process, same
 * number" and the record is treated as stale.
 */
export interface InjectRecord {
  pid: number;
  /** `/proc/<pid>/stat` field 22 (starttime, in clock ticks) at inject time. */
  startTime: string;
  /** Whether the post-login packet wait also completed (fully ready to fetch). */
  ready: boolean;
  /** Epoch ms when the record was written — diagnostics only. */
  injectedAt: number;
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

/**
 * WeQ 助手 config. When enabled (and an account is open) we fabricate a built-in
 * "WeQ助手" public-account conversation inside the LIVE QQ databases and run a
 * loopback HTTP server on `port` that QQ fetches for the card cover / jump page.
 * `msgId` caches the fabricated ARK message id so port changes can rewrite it in
 * place. Account-bound + off by default.
 */
export interface WeqAssistantConfig {
  enabled: boolean;
  port: number;
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
  weqAssistant: WeqAssistantConfig;
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
  // 20000+ 不常用端口；若被占用，启动时自动向上探测（见 weq_assistant/server.ts）。
  weqAssistant: { enabled: false, port: 27182 },
  agentLab: { providers: [] },
  windowCloseBehavior: 'ask',
};

export interface UserConfig {
  autoEnter?: AutoEnterTarget | null;
  tencentFilesRootOverride?: string | null;
  avatarCacheDir?: string | null;
  settings?: DeepPartial<AppSettings>;
  cacheDirOverride?: string | null;
  welcomeAcknowledged?: boolean;
  /**
   * 本机 WeQ助手 的固定 uid（`u_` + 22 位 [A-Za-z0-9-_]）。首次启用助手时随机生成一次并
   * 写在这里，之后恒定复用——见 {@link UserConfigService.getWeqAssistantUid}。
   */
  weqAssistantUid?: string;
  /**
   * Persisted hook-inject records (linux only), keyed by pid-as-string. Survives
   * a WeQ restart so an already-injected, still-running QQ isn't re-injected
   * (which would re-prompt for the password + race the hook pipe). Pruned
   * against live processes on startup and before each inject decision.
   */
  injectRecords?: Record<string, InjectRecord>;
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

  // ---- persisted hook-inject records (linux) ----

  /** All persisted inject records, keyed by pid-as-string. */
  getInjectRecords(): Record<string, InjectRecord> {
    return this.read().injectRecords ?? {};
  }

  /** The record for `pid`, or null if none is stored. */
  getInjectRecord(pid: number): InjectRecord | null {
    return this.getInjectRecords()[String(pid)] ?? null;
  }

  /** Upsert the inject record for a pid (merges over any existing fields). */
  setInjectRecord(record: InjectRecord): void {
    const records = { ...this.getInjectRecords(), [String(record.pid)]: record };
    this.write({ injectRecords: records });
    this.logger.info('stored inject record', {
      event: 'inject-record-set',
      pid: record.pid,
      ready: record.ready,
    });
  }

  /** Drop the record for a single pid (e.g. its hook pipe died). */
  deleteInjectRecord(pid: number): void {
    const records = this.getInjectRecords();
    if (!(String(pid) in records)) return;
    delete records[String(pid)];
    this.write({ injectRecords: records });
    this.logger.info('deleted inject record', { event: 'inject-record-delete', pid });
  }

  /**
   * Drop every record whose pid is no longer alive (or was recycled to a
   * different process — detected by a start-time mismatch). `liveStartTimes`
   * maps a currently-running pid to its `/proc/<pid>/stat` starttime; a pid
   * absent from the map is treated as dead. Returns the pruned records map.
   */
  pruneInjectRecords(liveStartTimes: Map<number, string>): Record<string, InjectRecord> {
    const records = this.getInjectRecords();
    let changed = false;
    for (const [key, rec] of Object.entries(records)) {
      const live = liveStartTimes.get(rec.pid);
      if (live === undefined || live !== rec.startTime) {
        delete records[key];
        changed = true;
        this.logger.info('pruned stale inject record', {
          event: 'inject-record-prune',
          pid: rec.pid,
          reason: live === undefined ? 'pid-dead' : 'pid-recycled',
        });
      }
    }
    if (changed) this.write({ injectRecords: records });
    return records;
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
      weqAssistant: {
        enabled: s?.weqAssistant?.enabled ?? d.weqAssistant.enabled,
        port: s?.weqAssistant?.port ?? d.weqAssistant.port,
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
      weqAssistant: {
        enabled: patch.weqAssistant?.enabled ?? current.weqAssistant.enabled,
        port: patch.weqAssistant?.port ?? current.weqAssistant.port,
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

  /**
   * 本机 WeQ助手 的固定 uid。首次调用时随机生成（`u_` + 22 位 [A-Za-z0-9-_]）并持久化，
   * 之后恒定返回同一个值。uid 必须稳定：一旦变化，QQ 库里会残留旧 uid 的孤儿会话，
   * 且头像文件的 hash 路径（md5³(uid)）也会随之改变。全网各安装各自随机，避免共用同一
   * 硬编码 uid 触发 QQ 风控。
   */
  getWeqAssistantUid(): string {
    const existing = this.read().weqAssistantUid;
    if (existing?.trim()) return existing;
    const uid = generateWeqAssistantUid();
    this.write({ weqAssistantUid: uid });
    this.logger.info('generated weq assistant uid', { event: 'weq-assistant-uid-generated' });
    return uid;
  }

  private defaultCacheBase(): string {
    return join(this.root, 'cache');
  }

  cacheBaseDir(): string {
    const o = this.read().cacheDirOverride;
    return o?.trim() ? o : this.defaultCacheBase();
  }

  getCacheDirInfo(): { effective: string; override: string | null; default: string } {
    const def = this.defaultCacheBase();
    const o = this.read().cacheDirOverride ?? null;
    return { effective: o?.trim() ? o : def, override: o, default: def };
  }

  setCacheDirOverride(dir: string | null): void {
    this.write({ cacheDirOverride: dir?.trim() ? dir : null });
    this.logger.info('updated cache directory override', {
      event: 'set-cache-dir-override',
      dir: dir?.trim() ? dir : null,
    });
  }

  /**
   * WeQ 缓存清理.
   *
   * The `<cacheBase>/<category>/` layout is written by various callers
   * (avatars, media previews, 商城表情, 语音转录). These four categories are
   * pure caches — every file is re-downloadable / re-generatable on demand,
   * so wiping them only costs a re-fetch. We deliberately DO NOT expose
   * `agentlab`（克隆体运行数据）, `weq-assistant`（推文/周报快照）or
   * `export`（导出产物）here: those hold user-generated content, not cache.
   */
  private static readonly CLEARABLE_CACHE_CATEGORIES: ReadonlyArray<{
    id: string;
    label: string;
  }> = [
    { id: 'avatar', label: '头像缓存' },
    { id: 'media', label: '图片/视频缓存' },
    { id: 'marketface', label: '商城表情缓存' },
    { id: 'voice', label: '语音转录缓存' },
  ];

  /** Per-category on-disk size (bytes) for the clearable cache categories. */
  listClearableCache(): Array<{ id: string; label: string; bytes: number }> {
    const base = this.cacheBaseDir();
    return UserConfigService.CLEARABLE_CACHE_CATEGORIES.map(({ id, label }) => ({
      id,
      label,
      bytes: dirSizeBytes(join(base, id)),
    }));
  }

  /**
   * Delete the given clearable cache categories (or all of them when `ids` is
   * omitted). Unknown / non-clearable ids are ignored — we never rm outside
   * the whitelist, so this can't touch agentlab / export / config / logs.
   * Returns the number of bytes freed.
   */
  clearCache(ids?: string[]): { freedBytes: number; cleared: string[] } {
    const base = this.cacheBaseDir();
    const allowed = new Set(
      UserConfigService.CLEARABLE_CACHE_CATEGORIES.map((c) => c.id),
    );
    const targets = (ids && ids.length > 0 ? ids : [...allowed]).filter((id) =>
      allowed.has(id),
    );
    let freedBytes = 0;
    const cleared: string[] = [];
    for (const id of targets) {
      const dir = join(base, id);
      if (!existsSync(dir)) continue;
      freedBytes += dirSizeBytes(dir);
      try {
        // Remove the category folder wholesale, then recreate it empty so the
        // next writer's mkdir -p is a no-op and nothing breaks mid-session.
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        cleared.push(id);
      } catch (error) {
        this.logger.error('failed to clear cache category', {
          event: 'clear-cache-failed',
          category: id,
          dir,
          ...logErrorContext(error),
        });
      }
    }
    this.logger.info('cleared weq cache', {
      event: 'clear-cache',
      cleared,
      freedBytes,
    });
    return { freedBytes, cleared };
  }
}

/**
 * Recursive directory byte size with a hard node-visit cap so a pathological
 * tree (the avatar/media caches can hold tens of thousands of tiny files)
 * can't wedge the caller. Missing dirs return 0.
 */
function dirSizeBytes(root: string, cap = 500_000): number {
  let total = 0;
  let visited = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (++visited > cap) return total;
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        stack.push(full);
      } else if (d.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* skip */
        }
      }
    }
  }
  return total;
}

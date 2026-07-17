/**
 * Bootstrap router — services usable before any account is selected.
 *
 *   - native-init status (so the renderer can show an error dialog)
 *   - install / process / account detection (cached in global config)
 *   - dbkey acquisition (3 flows) + key correctness probe
 *   - chart stats (db file sizes / nt_data subdir sizes)
 *   - auto-enter target read/write
 *   - manual key entry handoff (validate + open account)
 *
 * The QR / quick login flows are exposed as tRPC subscriptions, with the
 * underlying `AsyncIterable<KeyEvent>` converted to an `observable`.
 * superjson moves `bigint`s through unscathed.
 */

import { observable } from '@trpc/server/observable';
import { app, dialog } from 'electron';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isMcpRunning } from '../../mcp/server';
import { isWeqServerRunning } from '../../weq_assistant/server';
import {
  accountEventBus,
  getAppContext,
  requireBootstrap,
  requirePlatform,
  emitKeyFetchStalled,
  type AccountForcedClosedEvent,
  type KeyFetchStalledEvent,
} from '../../context/app_context';
import { procedure, router } from '../trpc';
import {
  accountConfigId,
  getLogger,
  type KeyEvent,
  type VoiceDownloadProgress,
  type TtsProviderConfig,
} from '@weq/service';
import { peekStaticSelfUin } from '@weq/account';
import { isTencentFilesRoot } from '@weq/platform';

/** Result of the Tencent Files folder picker (with the hard `Tencent Files` rule). */
export interface PickRootResult {
  /** True only when a valid `Tencent Files` folder was picked and persisted. */
  ok: boolean;
  /** The path the user picked (kept on rejection so the UI can show it), or null on cancel. */
  path: string | null;
  /** Human-readable reason when `ok` is false and the user didn't just cancel. */
  error?: string;
}

const algoSchema = z.object({
  pageHmacAlgorithm: z.string(),
  kdfHmacAlgorithm: z.string(),
});

const logger = getLogger().child({ scope: 'bootstrap-router' });

/**
 * QQ pids the embedded hook has been injected into during THIS app session.
 * Re-injecting a live pid forces the native pipe client to reconnect, which
 * races the hook's single-listener pipe and fails with ERROR_PIPE_BUSY — so we
 * inject once per pid and reuse the cached native client thereafter (see
 * `fetchKeyFromInstance`). Process-scoped: a full app restart resets it (and
 * also resets the native client cache), which is exactly when re-injection is
 * actually needed again.
 */
const injectedPids = new Set<number>();

export const bootstrapRouter = router({
  // ---- native health ----

  /** Classified native-init error, or null when the bundle loaded fine. */
  nativeStatus: procedure.query(() => {
    return getAppContext().nativeError;
  }),

  /** Background account session was forcibly closed by main process. */
  onAccountForcedClosed: procedure.subscription(() => {
    return observable<AccountForcedClosedEvent>((emit) => {
      const handler = (event: AccountForcedClosedEvent): void => {
        emit.next(event);
      };
      accountEventBus.on('forcedClosed', handler);
      return () => {
        accountEventBus.off('forcedClosed', handler);
      };
    });
  }),

  /**
   * Alive QQ instance stalled without a real recv packet (linux). Central
   * channel so the renderer surfaces one consistent "poke the account" hint
   * no matter which flow hit the stall.
   */
  onKeyFetchStalled: procedure.subscription(() => {
    return observable<KeyFetchStalledEvent>((emit) => {
      const handler = (event: KeyFetchStalledEvent): void => {
        emit.next(event);
      };
      accountEventBus.on('keyFetchStalled', handler);
      return () => {
        accountEventBus.off('keyFetchStalled', handler);
      };
    });
  }),

  /**
   * The renderer login race timed out waiting on an alive instance. It handles
   * its own continue/kill prompt, but reports the stall here so the stall is
   * logged and broadcast through the same central channel as background flows.
   */
  reportKeyStalled: procedure
    .input(z.object({ uin: z.string().optional() }))
    .mutation(({ input }) => {
      emitKeyFetchStalled('login', input.uin);
      return { ok: true as const };
    }),

  /** Platform kind, so the renderer can branch linux-only key behaviour. */
  systemInfo: procedure.query(() => {
    return { platformKind: process.platform as NodeJS.Platform };
  }),

  /**
   * Force-terminate a QQ process by pid. Used by the login race when the user
   * opts to abandon the alive-instance path and switch to ninebird.
   */
  killQqProcess: procedure
    .input(z.object({ pid: z.number().int().positive() }))
    .mutation(({ input }) => {
      try {
        process.kill(input.pid);
        return { ok: true as const };
      } catch (e) {
        logger.warn('killQqProcess failed', {
          event: 'router-kill-qq-failed',
          pid: input.pid,
          error: e instanceof Error ? e.message : String(e),
        });
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    }),

  // ---- detection (via global config cache) ----

  /** Enriched, cached install info (paths + version + user-data + health flags). */
  describeInstall: procedure.query(() => {
    return requireBootstrap().globalConfig.describeInstall();
  }),

  /** Force a fresh install probe (e.g. after the user changes the data dir). */
  refreshInstall: procedure.mutation(() => {
    return requireBootstrap().globalConfig.refresh();
  }),

  listAccounts: procedure.query(() => {
    return requireBootstrap().detect.listAccounts();
  }),

  detectRunningProcesses: procedure.query(() => {
    return requireBootstrap().detect.detectRunningProcesses();
  }),

  /** Online-instance probe (with the single-process uin-iteration refinement). */
  probeOnline: procedure
    .input(z.object({ knownUins: z.array(z.string()).default([]) }).optional())
    .query(({ input }) => {
      return requireBootstrap().globalConfig.probeOnline(input?.knownUins ?? []);
    }),

  /** Count of user-data directories under the Tencent Files root. */
  countUserDataDirs: procedure.query(() => {
    return requireBootstrap().globalConfig.countUserDataDirs();
  }),

  // ---- chart stats ----

  /** Largest database files for an account (language-bar chart). */
  dbFileSizes: procedure
    .input(z.object({ uin: z.string(), topN: z.number().int().positive().max(20).optional() }))
    .query(({ input }) => {
      return requireBootstrap().globalConfig.dbFileSizes(input.uin, input.topN ?? 8);
    }),

  /** nt_data subdirectory sizes for an account (space chart; may be slow). */
  ntDataSizes: procedure
    .input(z.object({ uin: z.string() }))
    .query(({ input }) => {
      return requireBootstrap().globalConfig.ntDataSubdirSizes(input.uin);
    }),

  /** Total size of the account's user-data directory in bytes (may be slow). */
  accountDirSize: procedure
    .input(z.object({ uin: z.string() }))
    .query(({ input }) => {
      return requireBootstrap().globalConfig.accountDirSize(input.uin);
    }),

  // ---- user config ----

  readConfig: procedure.query(() => {
    return requireBootstrap().userConfig.read();
  }),

  listAccountConfigs: procedure.query(() => {
    return requireBootstrap().userConfig.listAccountConfigs();
  }),

  deleteAccountConfig: procedure
    .input(z.object({ configId: z.string() }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.deleteAccountConfig(input.configId);
      return true;
    }),

  // ---- auto-enter target ----

  getAutoEnter: procedure.query(() => {
    return requireBootstrap().userConfig.getAutoEnter();
  }),

  setAutoEnter: procedure
    .input(z.object({ uin: z.string(), dataDir: z.string().optional() }))
    .mutation(({ input }) => {
      const boot = requireBootstrap();
      const dataDir = input.dataDir ?? boot.globalConfig.accountDataDir(input.uin) ?? undefined;
      const configId = accountConfigId(input.uin, dataDir);
      boot.userConfig.setAutoEnter({ configId, uin: input.uin, ...(dataDir ? { dataDir } : {}) });
      logger.info('set auto-enter target from bootstrap router', {
        event: 'router-set-auto-enter',
        accountUin: input.uin,
        dataDir: dataDir ?? null,
        configId,
      });
      return true;
    }),

  clearAutoEnter: procedure.mutation(() => {
    requireBootstrap().userConfig.clearAutoEnter();
    return true;
  }),

  // ---- version (设置 → 全局设置) ----

  /** WeQ app version + the runtime versions, for the 全局设置 page. */
  getVersionInfo: procedure.query(() => {
    return {
      app: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      isDev: !app.isPackaged,
    };
  }),

  // ---- app settings (设置 → 账号基础 / 全局设置) ----

  /** Full, defaulted global settings (realtime / media-completion / clientkey). */
  getSettings: procedure.query(() => {
    return requireBootstrap().userConfig.getSettings();
  }),

  /**
   * Toggle 启用数据库监听. Persists, then applies live to the open account so the
   * nt_msg.db watcher mounts/unmounts immediately (no re-open needed).
   */
  setRealtimeEnabled: procedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ realtimeEnabled: input.enabled });
      getAppContext().applyRealtime(input.enabled);
      return true;
    }),

  /**
   * Patch the 媒体补全 config. The monitor's rkey harvesting reads `enabled`
   * live on its next poll.
   */
  setMediaCompletion: procedure
    .input(z.object({ enabled: z.boolean().optional() }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ mediaCompletion: input });
      return true;
    }),

  /**
   * Toggle 自动获取 ClientKey. Persists, and the monitor reads it live on its
   * next poll so clientkey harvesting starts/stops immediately (no re-open needed).
   */
  setAutoFetchClientKey: procedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ autoFetchClientKey: input.enabled });
      return true;
    }),

  /**
   * 空闲自动上锁阈值（分钟）。0 = 关闭自动上锁。渲染层的 AppLockOverlay
   * 读取该值驱动空闲计时；手动上锁与之无关，始终可用。
   */
  setAutoLockMinutes: procedure
    .input(z.object({ minutes: z.number().int().min(0).max(120) }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ autoLockMinutes: input.minutes });
      return true;
    }),

  /**
   * 关闭按钮行为（最小化到托盘 / 直接退出 / 每次询问）。主进程的 window
   * 'close' 拦截会在下一次关闭时读取该值——纯持久化，无需即时应用。
   */
  setWindowCloseBehavior: procedure
    .input(z.object({ behavior: z.enum(['ask', 'tray', 'quit']) }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ windowCloseBehavior: input.behavior });
      return true;
    }),

  // ---- MCP server (account-bound) ----

  /**
   * Current MCP server config + live state. `token` is returned in full (like
   * the db key in 账号基础); the renderer masks it for display. `running` is
   * true only while an account is open AND the server is listening.
   */
  getMcpStatus: procedure.query(() => {
    const mcp = requireBootstrap().userConfig.getSettings().mcp;
    return {
      enabled: mcp.enabled,
      port: mcp.port,
      token: mcp.token,
      host: '127.0.0.1',
      url: `http://127.0.0.1:${mcp.port}`,
      running: isMcpRunning(),
    };
  }),

  /**
   * Toggle the MCP server. On first enable a bearer token is generated. Persists,
   * then applies live to the open account (starts/stops the HTTP server without
   * re-opening). Throws (e.g. port already in use) so the renderer can report it.
   */
  setMcpEnabled: procedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const userConfig = requireBootstrap().userConfig;
      const current = userConfig.getSettings().mcp;
      const token = input.enabled && !current.token ? randomBytes(32).toString('hex') : current.token;
      userConfig.setSettings({ mcp: { enabled: input.enabled, token } });
      await getAppContext().applyMcp(userConfig.getSettings().mcp);
      return userConfig.getSettings().mcp;
    }),

  /** Change the listen port. Persists and restarts the server if it's running. */
  setMcpPort: procedure
    .input(z.object({ port: z.number().int().min(1).max(65535) }))
    .mutation(async ({ input }) => {
      const userConfig = requireBootstrap().userConfig;
      userConfig.setSettings({ mcp: { port: input.port } });
      await getAppContext().applyMcp(userConfig.getSettings().mcp);
      return userConfig.getSettings().mcp;
    }),

  /** Generate a fresh bearer token. Persists and restarts the server if running. */
  regenerateMcpToken: procedure.mutation(async () => {
    const userConfig = requireBootstrap().userConfig;
    userConfig.setSettings({ mcp: { token: randomBytes(32).toString('hex') } });
    await getAppContext().applyMcp(userConfig.getSettings().mcp);
    return userConfig.getSettings().mcp;
  }),

  /** A ready-to-paste client config snippet (Claude Desktop + mcp-remote fallback). */
  getMcpClientConfig: procedure.query(() => {
    const mcp = requireBootstrap().userConfig.getSettings().mcp;
    const url = `http://127.0.0.1:${mcp.port}`;
    return JSON.stringify(
      {
        mcpServers: {
          weq: {
            // 原生支持 Streamable HTTP 的客户端直接用 url + headers：
            url,
            headers: { Authorization: `Bearer ${mcp.token}` },
            // 仅支持 stdio 的客户端（如部分旧版 Claude Desktop）改用下面这行：
            // "command": "npx",
            // "args": ["mcp-remote", "<url>", "--header", "Authorization: Bearer <token>"]
          },
        },
      },
      null,
      2,
    );
  }),

  // ---- WeQ 助手 (account-bound; renders inside QQ itself) ----

  /** Current WeQ 助手 config + live state. */
  getWeqAssistantStatus: procedure.query(() => {
    const weq = requireBootstrap().userConfig.getSettings().weqAssistant;
    return {
      enabled: weq.enabled,
      port: weq.port,
      host: '127.0.0.1',
      url: `http://127.0.0.1:${weq.port}`,
      running: isWeqServerRunning(),
    };
  }),

  /**
   * Toggle WeQ 助手. On enable (with an account open) it fabricates the built-in
   * conversation in the live QQ db + starts the loopback server; on disable it
   * stops the server (the conversation data is left in place). Persists first,
   * then applies live. Throws so the renderer can report failures.
   */
  setWeqAssistantEnabled: procedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const userConfig = requireBootstrap().userConfig;
      userConfig.setSettings({ weqAssistant: { enabled: input.enabled } });
      await getAppContext().applyWeqAssistant(userConfig.getSettings().weqAssistant);
      return userConfig.getSettings().weqAssistant;
    }),

  /**
   * Change the listen port (20000–65535). Persists, then re-applies: restarts
   * the server and rewrites the ARK card's embedded coverUrl / jump url so the
   * message in QQ points at the new port.
   */
  setWeqAssistantPort: procedure
    .input(z.object({ port: z.number().int().min(20000).max(65535) }))
    .mutation(async ({ input }) => {
      const userConfig = requireBootstrap().userConfig;
      userConfig.setSettings({ weqAssistant: { port: input.port } });
      await getAppContext().applyWeqAssistant(userConfig.getSettings().weqAssistant);
      return userConfig.getSettings().weqAssistant;
    }),

  // ---- first-run onboarding (欢迎使用) ----

  /** True once the user confirmed the first-run 欢迎使用 dialog. */
  getWelcomeAcknowledged: procedure.query(() => {
    return requireBootstrap().userConfig.isWelcomeAcknowledged();
  }),

  /** Mark the first-run 欢迎使用 dialog as confirmed (persists to config.json). */
  acknowledgeWelcome: procedure.mutation(() => {
    requireBootstrap().userConfig.acknowledgeWelcome();
    return true;
  }),

  // ---- voice transcription models (设置 → 语音转录) ----

  /** The model registry, each entry enriched with on-disk / in-flight state. */
  voiceModels: procedure.query(() => {
    return requireBootstrap().voiceTranscribe.listModels();
  }),

  /**
   * Start downloading a model (fire-and-forget). Progress is delivered via the
   * `onVoiceModelProgress` subscription; returns immediately so the renderer's
   * mutation doesn't block on a 245 MB download.
   */
  downloadVoiceModel: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => {
      // Don't await — the subscription drives the UI. Swallow rejections here;
      // the terminal 'progress' event already carries the error.
      void requireBootstrap().voiceTranscribe.downloadModel(input.id).catch(() => {});
      return true;
    }),

  /** Subscribe to voice-model download progress (all models share one stream). */
  onVoiceModelProgress: procedure.subscription(() => {
    return observable<VoiceDownloadProgress>((emit) => {
      const handler = (p: VoiceDownloadProgress): void => emit.next(p);
      const svc = requireBootstrap().voiceTranscribe;
      svc.on('progress', handler);
      return () => {
        svc.off('progress', handler);
      };
    });
  }),

  /** Delete a downloaded model's files. No-op while a download is in flight. */
  deleteVoiceModel: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => {
      return requireBootstrap().voiceTranscribe.deleteModel(input.id);
    }),

  /** Set (or clear with '') the selected transcription model id. */
  setVoiceModel: procedure
    .input(z.object({ modelId: z.string() }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ voiceTranscribe: { modelId: input.modelId } });
      return true;
    }),

  // ---- agent lab provider config ----

  getAgentLabCatalog: procedure.query(() => {
    return requireBootstrap().agentLabConfig.listCatalog();
  }),

  listAgentLabProviders: procedure.query(() => {
    return requireBootstrap().agentLabConfig.listProviders();
  }),

  saveAgentLabProvider: procedure
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        vendor: z.string().min(1),
        baseUrl: z.string().min(1),
        apiKey: z.string().min(1),
        models: z
          .array(
            z.object({
              id: z.string().min(1),
              label: z.string().optional(),
              capabilities: z.array(z.enum(['chat', 'embedding', 'vision'])),
            }),
          )
          .default([]),
      }),
    )
    .mutation(({ input }) => {
      return requireBootstrap().agentLabConfig.saveProvider(input);
    }),

  deleteAgentLabProvider: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => {
      return requireBootstrap().agentLabConfig.deleteProvider(input.id);
    }),

  /** 「测试连通性」：用表单里的 base_url + api_key + 某个 chat 模型探活，返回详细错误（含状态码/响应体）。 */
  testAgentLabProvider: procedure
    .input(
      z.object({
        baseUrl: z.string().min(1),
        apiKey: z.string().default(''),
        model: z.string().min(1),
      }),
    )
    .mutation(({ input }) => {
      return requireBootstrap().agentLabConfig.testEndpoint(input);
    }),

  // ---- TTS 服务商（设置 → 语音配置；克隆体发语音/语音克隆用）----

  /** 厂商模板（新建 provider 一键带入 + 表单字段提示）。 */
  getTtsCatalog: procedure.query(() => {
    return requireBootstrap().tts.listCatalog();
  }),

  /** 已保存的 TTS 服务商列表。 */
  listTtsProviders: procedure.query(() => {
    return requireBootstrap().userConfig.getSettings().voiceTranscribe.ttsProviders;
  }),

  /** 新增/更新一个 TTS 服务商（按 id upsert，保留 createdAt）。 */
  saveTtsProvider: procedure
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        vendor: z.enum(['openai-compatible', 'gsv2p', 'minimax', 'mimo', 'doubao', 'gpt-sovits', 'cosyvoice']),
        baseUrl: z.string().min(1),
        apiKey: z.string().default(''),
        appId: z.string().optional(),
        resourceId: z.string().optional(),
        model: z.string().optional(),
        cloneModel: z.string().optional(),
        voice: z.string().optional(),
        format: z.string().optional(),
        speed: z.number().optional(),
      }),
    )
    .mutation(({ input }) => {
      const cfg = requireBootstrap().userConfig;
      const now = Date.now();
      const existing = cfg.getSettings().voiceTranscribe.ttsProviders;
      const prior = existing.find((p) => p.id === input.id);
      const saved: TtsProviderConfig = { ...input, createdAt: prior?.createdAt ?? now, updatedAt: now };
      const next = [...existing.filter((p) => p.id !== input.id), saved].sort((a, b) => b.updatedAt - a.updatedAt);
      cfg.setSettings({ voiceTranscribe: { ttsProviders: next } });
      return saved;
    }),

  /** 删除一个 TTS 服务商。 */
  deleteTtsProvider: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => {
      const cfg = requireBootstrap().userConfig;
      const next = cfg.getSettings().voiceTranscribe.ttsProviders.filter((p) => p.id !== input.id);
      cfg.setSettings({ voiceTranscribe: { ttsProviders: next } });
      return true;
    }),

  /** 「测试」：用该配置合成一句样例，返回 base64 供前端试听。 */
  testTtsProvider: procedure
    .input(
      z.object({
        id: z.string().default('test'),
        name: z.string().default('test'),
        vendor: z.enum(['openai-compatible', 'gsv2p', 'minimax', 'mimo', 'doubao', 'gpt-sovits', 'cosyvoice']),
        baseUrl: z.string().min(1),
        apiKey: z.string().default(''),
        appId: z.string().optional(),
        resourceId: z.string().optional(),
        model: z.string().optional(),
        cloneModel: z.string().optional(),
        voice: z.string().optional(),
        format: z.string().optional(),
        speed: z.number().optional(),
      }),
    )
    .mutation(({ input }) => {
      const now = Date.now();
      const cfg: TtsProviderConfig = { ...input, createdAt: now, updatedAt: now };
      return requireBootstrap().tts.testProvider(cfg);
    }),

  // ---- cache directory (设置 → 账号信息 → 账号缓存路径) ----

  /** Effective / override / default cache paths for display. */
  getCacheDir: procedure.query(() => {
    return requireBootstrap().userConfig.getCacheDirInfo();
  }),

  /** Folder dialog → set the cache override. Returns the new path info. */
  pickCacheDir: procedure.mutation(async () => {
    const boot = requireBootstrap();
    const result = await dialog.showOpenDialog({
      title: '选择缓存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return boot.userConfig.getCacheDirInfo();
    }
    const picked = result.filePaths[0];
    if (picked) boot.userConfig.setCacheDirOverride(picked);
    return boot.userConfig.getCacheDirInfo();
  }),

  /** Clear the cache override (revert to the default). Returns new path info. */
  clearCacheDir: procedure.mutation(() => {
    const boot = requireBootstrap();
    boot.userConfig.setCacheDirOverride(null);
    return boot.userConfig.getCacheDirInfo();
  }),

  /**
   * Per-category size of the clearable WeQ caches (头像/媒体/商城表情/语音).
   * Only these re-downloadable/re-generatable categories are listed —
   * agentlab / weq-assistant / export are user content and stay untouched.
   */
  listClearableCache: procedure.query(() => {
    return requireBootstrap().userConfig.listClearableCache();
  }),

  /** Delete the given clearable cache categories (all when omitted). */
  clearWeqCache: procedure
    .input(z.object({ ids: z.array(z.string()).optional() }).optional())
    .mutation(({ input }) => {
      return requireBootstrap().userConfig.clearCache(input?.ids);
    }),

  // ---- filesystem dialog (Tencent Files fallback / manual db pick) ----

  pickTencentFilesRoot: procedure.mutation(async (): Promise<PickRootResult> => {
    const result = await dialog.showOpenDialog({
      title: '选择 Tencent Files 目录（必须选到 Tencent Files 文件夹本身）',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, path: null };
    }
    const picked = result.filePaths[0] ?? null;
    if (!picked) return { ok: false, path: null };
    // Hard rule: the override must point at the `Tencent Files` folder itself,
    // not a parent or the per-account `…\Tencent Files\<uin>` subdir. Reject
    // anything else so the user gets a clear message instead of a silent miss.
    if (!isTencentFilesRoot(picked)) {
      logger.warn('rejected non-Tencent-Files data dir pick', {
        event: 'pick-root-rejected',
        picked,
      });
      return {
        ok: false,
        path: picked,
        error: '请选择名为「Tencent Files」的文件夹本身（不要选里面的 QQ 号子目录，也不要选它的上级目录）。',
      };
    }
    requireBootstrap().globalConfig.setTencentFilesRootOverride(picked);
    logger.info('set Tencent Files data dir override', {
      event: 'pick-root-accepted',
      picked,
    });
    return { ok: true, path: picked };
  }),

  pickMsgDb: procedure.mutation(async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 nt_msg.db',
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  }),

  pickStaticDbDir: procedure.mutation(async () => {
    const result = await dialog.showOpenDialog({
      title: '选择已解密的 QQ 数据库目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  }),

  // ---- key correctness probe ----

  /**
   * Test a dbkey against an account's `nt_msg.db` without opening a session.
   * Returns the resolved algorithms on success so `openAccount` can reuse
   * them (no double probe). This is the gate the UI runs before "进入".
   */
  testDatabaseKey: procedure
    .input(z.object({ uin: z.string(), dbKey: z.string(), dbPathOverride: z.string().optional() }))
    .mutation(async ({ input }) => {
      const platform = requirePlatform();
      const dbPath = input.dbPathOverride ?? platform.ntMsgDbPath(input.uin);
      if (!dbPath || !existsSync(dbPath)) {
        return { success: false as const, error: `未找到该账号的 nt_msg.db（uin=${input.uin}）` };
      }
      try {
        const probe = await platform.native.ntHelper.testDatabaseKey(dbPath, input.dbKey);
        if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
          return { success: false as const, error: '数据库密钥不正确' };
        }
        return {
          success: true as const,
          algo: {
            pageHmacAlgorithm: probe.pageHmacAlgorithm,
            kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
          },
        };
      } catch (e) {
        return { success: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    }),

  // ---- key flows ----

  /**
   * Flow 1 — alive QQ instance. Caller passes pid + dbPath; we inject the
   * embedded hook (idempotent inside native), then ask for the key.
   */
  fetchKeyFromInstance: procedure
    .input(z.object({ pid: z.number().int().positive(), dbPath: z.string() }))
    .mutation(async ({ input }) => {
      const platform = requirePlatform();
      const boot = requireBootstrap();
      // Validate the db file exists before handing it to native — otherwise the
      // addon opens it itself and surfaces an opaque "Failed to open db" error.
      if (!existsSync(input.dbPath)) {
        logger.warn('key fetch aborted: db file not found', {
          event: 'router-fetch-key-missing-db',
          pid: input.pid,
          dbPath: input.dbPath,
        });
        return { success: false as const, error: `未找到数据库文件：${input.dbPath}` };
      }
      logger.info('router requested key from running instance', {
        event: 'router-fetch-key-from-instance',
        pid: input.pid,
        dbPath: input.dbPath,
        alreadyInjected: injectedPids.has(input.pid),
      });

      // Inject the embedded hook once per pid per app session. Re-injecting a
      // live pid forces a native reconnect that races the hook's single-listener
      // pipe (ERROR_PIPE_BUSY); skipping it lets the cached native client be
      // reused. The native side also reuses a healthy connection now, so this is
      // belt-and-suspenders against that race.
      if (!injectedPids.has(input.pid)) {
        await platform.native.ntHelper.injectAndGetStatusEmbedded(input.pid);
        injectedPids.add(input.pid);
      }

      let result = await boot.keys.fetchFromInstance(input.pid, input.dbPath);
      if (!result.success) {
        // The cached native client may have died (QQ relaunched / hook
        // unloaded). Re-inject once — a genuinely closed client reconnects
        // cleanly — and retry a single time.
        logger.warn('key fetch failed; re-injecting and retrying once', {
          event: 'router-fetch-key-retry',
          pid: input.pid,
          error: result.error,
        });
        injectedPids.delete(input.pid);
        await platform.native.ntHelper.injectAndGetStatusEmbedded(input.pid);
        injectedPids.add(input.pid);
        result = await boot.keys.fetchFromInstance(input.pid, input.dbPath);
      }
      return result;
    }),

  /**
   * Flow 2 — quick login. Subscription so the renderer can show
   * "found these accounts in login.db" before the dbkey lands.
   */
  quickLogin: procedure
    .input(
      z.object({
        uin: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<KeyEvent>((emit) => {
        const stream = requireBootstrap().keys.quickLoginStream({
          uin: input.uin,
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        });
        const iterator = stream[Symbol.asyncIterator]();
        let cancelled = false;

        void (async (): Promise<void> => {
          try {
            for (;;) {
              const next = await iterator.next();
              if (next.done || cancelled) break;
              emit.next(next.value);
            }
            emit.complete();
          } catch (e) {
            emit.error(e);
          }
        })();

        return () => {
          cancelled = true;
          void iterator.return?.();
        };
      });
    }),

  /** Flow 3 — QR login. Same shape as quickLogin. */
  qrLogin: procedure
    .input(
      z
        .object({ timeoutMs: z.number().int().positive().optional() })
        .optional(),
    )
    .subscription(({ input }) => {
      return observable<KeyEvent>((emit) => {
        const stream = requireBootstrap().keys.qrLoginStream({
          ...(input?.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        });
        const iterator = stream[Symbol.asyncIterator]();
        let cancelled = false;

        void (async (): Promise<void> => {
          try {
            for (;;) {
              const next = await iterator.next();
              if (next.done || cancelled) break;
              emit.next(next.value);
            }
            emit.complete();
          } catch (e) {
            emit.error(e);
          }
        })();

        return () => {
          cancelled = true;
          void iterator.return?.();
        };
      });
    }),

  // ---- account open / close ----

  /**
   * Open an account session. Caller supplies uin + dbkey, optionally the
   * pre-probed `algo` (from `testDatabaseKey`) and display metadata that gets
   * persisted into the saved-config record (keyed by data directory).
   *
   * When `algo` is absent we probe it here (also acting as a key-correctness
   * gate). Throws on a wrong key so the renderer surfaces an error dialog.
   */
  openAccount: procedure
    .input(
      z.object({
        uin: z.string(),
        dbKey: z.string(),
        algo: algoSchema.optional(),
        displayName: z.string().optional(),
        avatarUrl: z.string().optional(),
        dataDir: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const ctx = getAppContext();
      const platform = requirePlatform();

      let algo = input.algo;
      if (!algo) {
        const msgDbPath = platform.ntMsgDbPath(input.uin);
        if (!msgDbPath) {
          throw new Error(`nt_msg.db not found for uin=${input.uin}`);
        }
        const probe = await platform.native.ntHelper.testDatabaseKey(msgDbPath, input.dbKey);
        if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
          throw new Error('数据库密钥不正确，无法打开。');
        }
        algo = {
          pageHmacAlgorithm: probe.pageHmacAlgorithm,
          kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
        };
      }

      const dataDir =
        input.dataDir ?? requireBootstrap().globalConfig.accountDataDir(input.uin) ?? undefined;

      await ctx.setAccount(
        { uin: input.uin, dbKey: input.dbKey, algo },
        {
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
          ...(dataDir ? { dataDir } : {}),
        },
      );
      return ctx.account!.context;
    }),

  closeAccount: procedure.mutation(() => {
    logger.info('router closing account', { event: 'router-close-account' });
    getAppContext().clearAccount();
    return true;
  }),

  // ---- static (offline) account from local databases ----

  /**
   * Probe a directory of local QQ databases. Tries to read the self row
   * from `profile_info_v6` so the UI can show the resolved UIN / nickname
   * before committing to an open.
   *
   *   - No key, plain SQLite succeeds → returns `{ ok: true, needKey: false, preview }`
   *   - SQLCipher with correct key    → same
   *   - SQLCipher without key (or wrong key) → `{ ok: true, needKey: true }`
   *     (needKey=true is not a hard error; the UI then prompts for a key)
   *   - Missing files / corrupt db   → `{ ok: false, error }`
   */
  testStaticDir: procedure
    .input(
      z.object({
        dirPath: z.string().min(1),
        dbKey: z.string().optional(),
        algo: algoSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const platform = requirePlatform();
      if (!existsSync(input.dirPath)) {
        return { ok: false as const, error: `目录不存在：${input.dirPath}` };
      }
      const profileInfoPath = join(input.dirPath, 'profile_info.db');
      const ntMsgPath = join(input.dirPath, 'nt_msg.db');
      if (!existsSync(profileInfoPath)) {
        return { ok: false as const, error: '未在所选目录中找到 profile_info.db' };
      }
      if (!existsSync(ntMsgPath)) {
        return { ok: false as const, error: '未在所选目录中找到 nt_msg.db' };
      }
      try {
        const preview = await peekStaticSelfUin(
          platform,
          input.dirPath,
          input.dbKey,
          input.algo,
        );
        return {
          ok: true as const,
          needKey: false as const,
          preview: {
            uin: preview.uin,
            displayName: preview.nick,
            avatarUrl: preview.avatarUrl,
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Caller didn't supply a key — ask for one. NOT a hard error.
        if (!input.dbKey) {
          return { ok: true as const, needKey: true as const };
        }
        return { ok: false as const, error: `无法打开数据库：${msg}` };
      }
    }),

  /**
   * Open a static (offline) account. The caller must have already resolved
   * a self preview (UIN + nick) via `testStaticDir`; we don't trust the
   * directory name as a UIN. `dbKey` is required for SQLCipher backups;
   * omit it for already-decrypted plain SQLite folders.
   */
  openStaticAccount: procedure
    .input(
      z.object({
        dirPath: z.string().min(1),
        dbKey: z.string().optional(),
        algo: algoSchema.optional(),
        preview: z.object({
          uin: z.string().min(1),
          displayName: z.string(),
          avatarUrl: z.string(),
        }),
      }),
    )
    .mutation(async ({ input }) => {
      const ctx = getAppContext();
      if (!existsSync(input.dirPath)) {
        throw new Error(`目录不存在：${input.dirPath}`);
      }
      const ntMsgPath = join(input.dirPath, 'nt_msg.db');
      if (!existsSync(ntMsgPath)) {
        throw new Error(`未在所选目录中找到 nt_msg.db：${input.dirPath}`);
      }
      await ctx.setStaticAccount(input.dirPath, input.preview, {
        ...(input.dbKey ? { dbKey: input.dbKey } : {}),
        ...(input.algo ? { algo: input.algo } : {}),
      });
      return ctx.account!.context;
    }),

  /** True if an account session is currently open. */
  accountOpen: procedure.query(() => {
    return getAppContext().account !== null;
  }),
});

// Sanity helper — kept exported so consumers can guard against junk paths
// from the dialog without re-importing fs everywhere.
export function tencentFilesLooksReal(root: string): boolean {
  return existsSync(join(root, 'nt_qq')) || existsSync(join(root));
}

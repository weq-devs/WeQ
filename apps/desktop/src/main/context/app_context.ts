/**
 * Single source of truth for everything the main process holds in memory.
 *
 * Lifecycle:
 *   - `initAppContext()` runs once after `app.whenReady`.
 *   - Bootstrap services (detect / keys / userConfig / globalConfig) live for
 *     the whole process — they only depend on Platform.
 *   - `account` is mutable: starts null, set when the user confirms a key,
 *     cleared when the user closes the account.
 *
 * Native-load failure is NON-FATAL here: instead of throwing (which would
 * leave the renderer with a blank window), we capture the classified error in
 * `nativeError` and leave the platform-dependent services null. The renderer
 * queries `bootstrap.nativeStatus` first and renders an error dialog — per the
 * spec ("native 过期提示版本过旧；其它安装损坏都显示安装损坏；自实现弹窗").
 *
 * No DI framework. Pulling services through `getAppContext()` (plus the
 * `requireBootstrap()` / `requireGlobalConfig()` guards) is enough.
 */

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadNativeSafe } from '@weq/native';
import { createWin32Platform, createLinuxPlatform, isTencentFilesRoot, type Platform } from '@weq/platform';
import { startMcpServer, stopMcpServer } from '../mcp/server';
import { startWeqServer, stopWeqServer } from '../weq_assistant/server';
import { refreshWeqStats, setWeqStats, statsCachePath } from '../weq_assistant/stats';
import { ensureDefaultTweets, tweetsStorePath } from '../weq_assistant/tweets';
import { aiToolSpecs, runAiTool } from '../mcp/openai_tools';
import { getExternalMcpHub, disposeExternalMcp } from '../mcp/external';
import { sampleHitokoto } from '../hitokoto';
import { pkexecStubHooks } from '../stub_elevation';
import { getQqProtocolExe } from './qq_protocol';
import { createPkexecInjectHook } from '../inject_elevation';
import {
  accountConfigId,
  UserConfigService,
  Win32DetectService,
  Win32KeyService,
  GlobalConfigService,
  AvatarCacheService,
  AgentLabConfigService,
  VoiceTranscribeService,
  TtsService,
  getVoiceModel,
  MsgService,
  RecentContactService,
  UnreadInfoService,
  AccountConfigService,
  AccountMonitorService,
  MediaDownloadService,
  MediaUrlService,
  ForwardMsgService,
  GroupInfoService,
  BuddyAnalyticsService,
  GroupNotifyService,
  ProfileService,
  FileAssistantService,
  FileSearchService,
  EmojiService,
  MsgSearchService,
  OnlineStatusService,
  AgentLabService,
  AssistantService,
  CollectionService,
  TokenUsageStore,
  ConversationStore,
  DeletedMsgStore,
  AntiRecallService,
  DbDecryptService,
  DbExplorerService,
  AvatarResourceService,
  SysEmojiResourceService,
  MarketEmojiResourceService,
  CustomEmojiResourceService,
  RelatedEmojiResourceService,
  FileResourceService,
  MediaResourceService,
  ResourceCleanupService,
  WebQueryService,
  GroupAlbumMediaService,
  DbWatchService,
  checkAccountDatabaseHealth,
  createNtMsgDbHook,
  formatDbHealthFailures,
  initLogger,
  getLogger,
  getLogDir,
  logErrorContext,
  type AccountConfigMetadata,
  type DbWatchHandle,
  type NewMessages,
  type DbChange,
  type DbHealthFailure,
  type McpServerConfig,
  type WeqAssistantConfig,
  WeqAssistantService,
  createDirectInjectHook,
  type InjectHook,
} from '@weq/service';
import { resolveResource } from '../resource';
import { openAccount, openStaticAccount, type AccountContext, type AccountSession } from '@weq/account';
import { collectionItemToWire } from '../ipc/serde';

/**
 * Process-wide bus for nt_msg.db changes, fed by the single `dbWatch` loop
 * below. Two events:
 *   - `'changed'` ({@link DbChange})    — every db change (debounced); drives
 *     the open conversation's seq-window re-query in the renderer.
 *   - `'new'`     ({@link NewMessages}) — only when a rowid-delta found newly
 *     inserted rows; reserved for unread / popup notifications.
 * The account router turns each into a tRPC subscription.
 */
export const dbEventBus = new EventEmitter();

export interface AccountForcedClosedEvent {
  reason: 'database-damaged';
  title: string;
  message: string;
  details: string[];
  failures: DbHealthFailure[];
}

/**
 * The QQ instance is alive but the key/credential request can't complete —
 * on linux this means the injected hook hasn't yet observed a real post-login
 * recv packet, so it doesn't know the MSF service address and the OIDB request
 * stalls. Surfaced to the user with a "send the account any message to unblock"
 * hint. Emitted both by main-side background flows (monitor harvest, on-demand
 * credential fetch) and by the renderer's login race via `reportKeyStalled`.
 */
export interface KeyFetchStalledEvent {
  reason: 'packet-stalled';
  /** Which flow hit the stall — for the log + optional per-context copy. */
  source: 'login' | 'harvest' | 'credential';
  uin?: string;
  title: string;
  message: string;
}

export const accountEventBus = new EventEmitter();

/**
 * Process-wide uin→uid registry. On linux the on-disk account directory is
 * `nt_qq_<md5(md5(uid)+"nt_kernel")>`, so path resolution needs the string uid
 * for a given uin. A freshly-added account's uid isn't in the saved config yet
 * when `openAccount` first probes its db path, so the router seeds it here via
 * `rememberAccountUid` before the lookup. The linux platform's uid resolver
 * checks this map first, then falls back to the persisted account configs.
 */
const uidRegistry = new Map<string, string>();

/** Seed the uin→uid map (called from the openAccount flow). No-op off linux. */
export function rememberAccountUid(uin: string, uid: string): void {
  if (uin && uid) uidRegistry.set(uin, uid);
}

/**
 * The single source of truth for the "alive QQ but can't send the packet" copy.
 * The linux hook needs one real post-login recv packet to learn the MSF service
 * address; until then key/credential OIDB requests stall. Telling the user to
 * poke the account with any message is the fastest unblock.
 */
export const KEY_STALL_TITLE = '在线取密钥较慢';
export const KEY_STALL_HINT =
  '当前 QQ 在线，但还没收到可用于定位服务地址的数据包，取密钥/凭据会卡住。用任意小号给该账号发一条消息即可立即解除等待；或改用扫码/快速登录获取。';

/**
 * Log + broadcast a {@link KeyFetchStalledEvent} on the shared bus. Both
 * main-side background flows and the renderer login race (via the
 * `reportKeyStalled` mutation) funnel through here so the copy and the log
 * event stay in one place.
 */
export function emitKeyFetchStalled(
  source: KeyFetchStalledEvent['source'],
  uin?: string,
): void {
  getLogger()
    .child({ scope: 'key-stall' })
    .warn('alive QQ instance stalled without a real recv packet', {
      event: 'key-fetch-stalled',
      source,
      uin: uin ?? null,
    });
  accountEventBus.emit('keyFetchStalled', {
    reason: 'packet-stalled',
    source,
    ...(uin ? { uin } : {}),
    title: KEY_STALL_TITLE,
    message: KEY_STALL_HINT,
  } satisfies KeyFetchStalledEvent);
}

/** Trailing debounce — coalesces a burst of calls into one after `ms` idle. */
function trailingDebounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
}

/** One polling loop for the whole process; we (un)mount the active db on it. */
const dbWatch = new DbWatchService();
/** Handle for the currently-watched account db, if any. */
let dbWatchHandle: DbWatchHandle | null = null;
/** Background login/pid/rkey monitor for the open account, if any. */
let accountMonitor: AccountMonitorService | null = null;
let dbHealthCheckSeq = 0;
/** Guards against running more than one full health check at a time. */
let dbHealthCheckRunning = false;

/**
 * Mount the nt_msg.db watcher for `session` (idempotent — no-op if already
 * mounted). The hook fans every change into two bus events: a debounced
 * 'changed' (drives the open-conversation re-query) and 'new' (rowid-delta,
 * for notifications). Gated by the 实时消息 setting via {@link mountDbWatch}'s
 * callers / `applyRealtime`.
 */
function mountDbWatch(session: AccountSession): void {
  if (dbWatchHandle) return;
  const emitChanged = trailingDebounce((file: DbChange) => {
    dbEventBus.emit('changed', file);
  }, 200);
  dbWatchHandle = dbWatch.mount(
    createNtMsgDbHook(session, {
      onDbChanged: emitChanged,
      onNewMessages: (change: NewMessages) => {
        dbEventBus.emit('new', change);
      },
    }),
  );
}

/** Stop watching the current account db, if any. */
function unmountDbWatch(): void {
  dbWatchHandle?.unmount();
  dbWatchHandle = null;
}

/**
 * Run the full per-account database health check **on demand** — triggered when
 * a live query rejected with an error that strongly looks like database
 * corruption (see `isLikelyCorruptionError` in `@weq/db`). It is deliberately
 * NOT run at account-open: a healthy database should never pay for the scan.
 *
 * Non-reentrant: only one check runs at a time. When it comes back clean the
 * gate reopens, so a later suspicion can re-verify (the trigger was a false
 * alarm / transient). Only a CONFIRMED corruption force-closes the account and
 * returns the user to the home screen.
 */
function startDbHealthCheck(ctx: AppContext, session: AccountSession, platform: Platform): void {
  const logger = getLogger().child({ scope: 'db-health', accountUin: session.context.uin });
  if (dbHealthCheckRunning) return;
  // Ignore late triggers from a session that has already been replaced/closed.
  if (ctx.account !== session) return;
  dbHealthCheckRunning = true;
  const seq = ++dbHealthCheckSeq;
  void (async (): Promise<void> => {
    try {
      logger.info('starting database health check', {
        event: 'db-health-check-start',
        msgDbPath: session.msgDbPath,
      });
      const failures = await checkAccountDatabaseHealth(session, platform);
      // A newer check started or the account changed mid-check — drop the result.
      if (seq !== dbHealthCheckSeq || ctx.account !== session) return;
      // 没检出损坏就不弹窗、不强退（误报/瞬时错误），放行让后续可再触发。
      if (failures.length === 0) return;

      if (failures.length === 0) {
        logger.info('database health check passed', { event: 'db-health-check-clean' });
        return;
      }

      const details = formatDbHealthFailures(failures);
      logger.error('database corruption confirmed', {
        event: 'db-health-check-failed',
        failureCount: failures.length,
        details,
      });
      ctx.clearAccount();
      accountEventBus.emit('forcedClosed', {
        reason: 'database-damaged',
        title: '数据库损坏',
        message:
          '检测到 QQ 数据库损坏，问题出在 QQ 数据库本身，不是 WeQ 软件导致。账号已强制退出并返回主页面。可以去 https://github.com/H3CoF6/WeQ/issues 提 issue，未来可能会做一个数据库修复工具。',
        details,
        failures,
      } satisfies AccountForcedClosedEvent);
    } catch (e) {
      if (seq !== dbHealthCheckSeq || ctx.account !== session) return;
      logger.error('database health check crashed', {
        event: 'db-health-check-error',
        ...logErrorContext(e),
      });
      const failure: DbHealthFailure = {
        dbName: '数据库健康检查',
        dbPath: session.msgDbPath,
        corruptedTables: [],
        error: e instanceof Error ? e.message : String(e),
      };
      ctx.clearAccount();
      accountEventBus.emit('forcedClosed', {
        reason: 'database-damaged',
        title: '数据库损坏',
        message:
          '检测 QQ 数据库健康状态时发生错误。为避免继续读取损坏数据，账号已强制退出并返回主页面。问题通常出在 QQ 数据库本身，不是 WeQ 软件导致。可以去 https://github.com/H3CoF6/WeQ/issues 提 issue，未来可能会做一个数据库修复工具。',
        details: formatDbHealthFailures([failure]),
        failures: [failure],
      } satisfies AccountForcedClosedEvent);
    } finally {
      dbHealthCheckRunning = false;
    }
  })();
}

export interface BootstrapServices {
  detect: Win32DetectService;
  keys: Win32KeyService;
  userConfig: UserConfigService;
  globalConfig: GlobalConfigService;
  avatarCache: AvatarCacheService;
  agentLabConfig: AgentLabConfigService;
  /** Voice-transcription model management (download/select). Account-independent. */
  voiceTranscribe: VoiceTranscribeService;
  /** Text-to-speech（克隆体发语音/语音克隆）。Account-independent，纯 fetch。 */
  tts: TtsService;
  /**
   * Turns a QQ pid into a sendable state before instance-key/rkey fetches.
   * linux → pkexec-elevated inject + wait-for-packet; other platforms →
   * in-process direct inject. Shared (single instance) so its per-pid
   * idempotency spans the router and every account monitor.
   */
  injectHook: InjectHook;
}

/** Services that are re-created whenever an account session opens. */
export interface AccountServices {
  msgs: MsgService;
  recentContacts: RecentContactService;
  unreadInfo: UnreadInfoService;
  accountConfig: AccountConfigService;
  forwardMsgs: ForwardMsgService;
  groupInfo: GroupInfoService;
  /** One-on-one (c2c) chat analytics for the private-chat analysis page. */
  buddyAnalytics: BuddyAnalyticsService;
  groupNotify: GroupNotifyService;
  profile: ProfileService;
  msgSearch: MsgSearchService;
  onlineStatus: OnlineStatusService;
  /** Locate on-disk media (pic/video/ptt/file) for the media protocol. */
  fileSearch: FileSearchService;
  /** CDN fallback download for media missing on disk (uses live rkeys). */
  mediaDownload: MediaDownloadService;
  /** OIDB/NTV2 download-URL resolver for video / file completion (needs online QQ). */
  mediaUrl: MediaUrlService;
  /** Search file entries by msgId or name. */
  fileAssistant: FileAssistantService;
  /** Decrypt + cache market-face (store sticker) images. */
  emoji: EmojiService;
  /** Friend clone / AgentLab personas bound to the current account. */
  agentLab: AgentLabService;
  /** WeQ assistant (tool-calling agent) bound to the current account. */
  assistant: import('@weq/service').AssistantService;
  /** Export task manager. */
  exportManager: import('@weq/service').ExportTaskManager;
  /** List and bulk-decrypt encrypted QQ NT databases. */
  dbDecrypt: DbDecryptService;
  /** SQLiteStudio-style browse / query / edit over the account's databases. */
  dbExplorer: DbExplorerService;
  /** 防撤回：安装/卸载拦截 QQ 撤回的 SQL 触发器 + 按会话选择配置。 */
  antiRecall: AntiRecallService;
  /** Browse the account's local avatar cache (nt_data/avatar/*). */
  avatarResource: AvatarResourceService;
  /** Browse the account's built-in system emoji resource dir. */
  sysEmoji: SysEmojiResourceService;
  /** Browse the account's market-face (store sticker) cache. */
  marketEmoji: import('@weq/service').MarketEmojiResourceService;
  /** Browse the account's custom-emoji cache (received + personal). */
  customEmoji: CustomEmojiResourceService;
  /** Browse the account's related-emoji cache (keyword → gif). */
  relatedEmoji: RelatedEmojiResourceService;
  /** Browse the account's File 目录 (nt_data/File/Ori) + 下载文件 (file_assistant.db). */
  fileResource: FileResourceService;
  /** Browse the account's local media caches (PhotoWall / Qzone / Pic / Video). */
  mediaResource: MediaResourceService;
  /** Clean up the account's nt_data resource trees (本地资源整理 → 清理释放). */
  resourceCleanup: ResourceCleanupService;
  /** Web CGI queries that need the already-hooked online QQ process. */
  webQuery: WebQueryService;
  /** Group album media listing over the already-hooked online QQ process. */
  groupAlbumMedia: GroupAlbumMediaService;
  /** QQ 收藏 (favorites) reader over collection.db. */
  collection: CollectionService;
}

/** Classified native-init failure surfaced to the renderer. */
export interface NativeInitError {
  /** 'expired' → "版本过旧请更新"; 'damaged' → "安装损坏". */
  kind: 'expired' | 'damaged';
  /** Raw status code if recoverable, else null. */
  status: number | null;
  /** Underlying message (diagnostics; not shown verbatim to users). */
  message: string;
}

export interface AppContext {
  /** null when native failed to load — check `nativeError` first. */
  platform: Platform | null;
  /** null when native failed to load. */
  bootstrap: BootstrapServices | null;
  /** Set when the native bundle could not be loaded; null on success. */
  nativeError: NativeInitError | null;
  /** Current account session. `null` until the user confirms a key. */
  account: AccountSession | null;
  /** Services bound to the current account. `null` if no account is open. */
  services: AccountServices | null;
  /** Per-account scheduled-export manager. Recreated with the account; its
   *  lifecycle is intentionally separate from `services` so the object
   *  literal can be fully constructed before this field is assigned. */
  scheduler: import('@weq/service').ExportScheduler | null;
  /** Open (or re-open) an account session. Disposes the previous one first. */
  setAccount(ctx: AccountContext, metadata?: AccountConfigMetadata): Promise<void>;
  /**
   * Open a static (offline) account from a directory of locally-stored
   * databases. Pass `selfPreview` (from `peekStaticSelfUin`) so we don't
   * have to trust the directory name as the UIN. Optional `dbKey` +
   * `algo` are for still-encrypted SQLCipher backups; omit them for
   * already-decrypted plain SQLite folders.
   */
  setStaticAccount(
    dirPath: string,
    selfPreview: { uin: string; displayName: string; avatarUrl: string },
    options?: { dbKey?: string; algo?: import('@weq/native').DatabaseAlgorithms },
  ): Promise<void>;
  /** Drop the current account session, if any. */
  clearAccount(): void;
  /**
   * Mount/unmount the live nt_msg.db watcher for the open account without
   * re-opening it. Called when the user toggles 启用数据库监听 so the change
   * takes effect immediately. No-op when no account is open.
   */
  applyRealtime(enabled: boolean): void;
  /**
   * Apply the MCP server config to the open account (start / stop / restart the
   * account-bound HTTP server) without re-opening the account. No-op start when
   * no account is open — the server starts lazily on next account open.
   */
  applyMcp(config: McpServerConfig): Promise<void>;
  /**
   * Apply the WeQ 助手 config to the open account: when enabled, fabricate the
   * built-in "WeQ助手" conversation in the live QQ db (idempotent) + start the
   * loopback HTTP server; when disabled, stop the server (account data is left
   * in place). Rewrites the ARK card when the port changed. No-op when no
   * account is open. Returns the port the server actually bound to (or 0).
   */
  applyWeqAssistant(config: WeqAssistantConfig): Promise<number>;
  /**
   * Force a one-shot rkey harvest from the online QQ for the open account —
   * the explicit refresh before a media-completing export. Resolves false when
   * no account is open / QQ is offline / harvest failed.
   */
  refreshRkeysNow(): Promise<boolean>;
}

let cached: AppContext | undefined;

export function initAppContext(): AppContext {
  if (cached) return cached;

  const result = loadNativeSafe();

  if (!result.ok) {
    // Degraded context: keep the app alive so the renderer can show a dialog.
    cached = {
      platform: null,
      bootstrap: null,
      nativeError: { kind: result.kind, status: result.status, message: result.message },
      account: null,
      services: null,
      scheduler: null,
      setAccount(): Promise<void> {
        throw new Error('native bundle failed to load — cannot open an account');
      },
      setStaticAccount(): Promise<void> {
        throw new Error('native bundle failed to load — cannot open a static account');
      },
      clearAccount(): void {
        /* nothing to clear */
      },
      applyRealtime(): void {
        /* no account to watch */
      },
      applyMcp(): Promise<void> {
        /* no account — nothing to serve */
        return Promise.resolve();
      },
      applyWeqAssistant(): Promise<number> {
        /* no account — nothing to serve */
        return Promise.resolve(0);
      },
      refreshRkeysNow(): Promise<boolean> {
        return Promise.resolve(false);
      },
    };
    return cached;
  }

  // The user-picked Tencent Files override lives in config.json
  // (UserConfigService), but UserConfigService needs `platform.appDataRoot()`
  // to construct — a cycle. Break it with a late-bound reader: the platform
  // calls this lazily on every path lookup, by which point `userConfig` is
  // assigned, so the override flows into login.db decrypt / db lookup / stats.
  let readDataRootOverride: () => string | null = () => null;

  // uin→uid registry for linux account-directory derivation. In-memory map wins
  // (covers a freshly-added account whose config isn't on disk yet); on a miss
  // we fall back to the saved account configs. Late-bound like the override
  // reader above because `userConfig` is constructed after `platform`.
  let readUidFromConfig: (uin: string) => string | null = () => null;
  const resolveUid = (uin: string): string | null =>
    uidRegistry.get(uin) ?? readUidFromConfig(uin);

  const platform =
    process.platform === 'linux'
      ? createLinuxPlatform(result.bundle, () => readDataRootOverride(), resolveUid)
      : createWin32Platform(result.bundle, () => readDataRootOverride(), getQqProtocolExe);
  initLogger(platform.appDataRoot());
  const logger = getLogger().child({ scope: 'app-context' });
  logger.info('initializing app context', {
    event: 'init-app-context',
    appDataRoot: platform.appDataRoot(),
    logDir: getLogDir(),
  });
  const userConfig = new UserConfigService(platform);
  readDataRootOverride = () => userConfig.read().tencentFilesRootOverride ?? null;
  readUidFromConfig = (uin: string): string | null => {
    for (const rec of userConfig.listAccountConfigs()) {
      if (rec.uin === uin && rec.uid) return rec.uid;
    }
    return null;
  };

  // Sanitize a legacy / malformed data-dir override on launch: a stored path
  // that no longer exists or doesn't end in `Tencent Files` (e.g. an old build
  // that saved `…\Tencent Files\<uin>`) is dropped so detection re-runs and the
  // user isn't stuck with a path that silently resolves nothing.
  const storedOverride = userConfig.read().tencentFilesRootOverride ?? null;
  if (storedOverride && (!existsSync(storedOverride) || !isTencentFilesRoot(storedOverride))) {
    userConfig.write({ tencentFilesRootOverride: null });
    logger.warn('cleared invalid Tencent Files override on launch', {
      event: 'sanitize-data-root-override',
      override: storedOverride,
      exists: existsSync(storedOverride),
      endsWithTencentFiles: isTencentFilesRoot(storedOverride),
    });
  }

  // Linux drops a ninebird entry stub into QQ's root-owned resources/app, so
  // it needs a pkexec-elevated writer. Windows uses the fs default (undefined).
  const stubHooks = process.platform === 'linux' ? pkexecStubHooks : undefined;

  // Injecting the hook into a running QQ needs root (ptrace) on linux, so it
  // goes through a pkexec child + a wait-for-packet step; other platforms
  // inject in-process. One shared instance so its per-pid idempotency spans the
  // bootstrap router and every account monitor.
  const injectHook: InjectHook =
    process.platform === 'linux'
      ? createPkexecInjectHook(platform.native.ntHelper, userConfig)
      : createDirectInjectHook(platform.native.ntHelper);

  const bootstrap: BootstrapServices = {
    detect: new Win32DetectService(platform, stubHooks),
    keys: new Win32KeyService(platform, stubHooks),
    userConfig,
    globalConfig: new GlobalConfigService(platform, userConfig),
    avatarCache: new AvatarCacheService(platform, userConfig),
    agentLabConfig: new AgentLabConfigService(userConfig),
    voiceTranscribe: new VoiceTranscribeService(platform),
    tts: new TtsService(),
    injectHook,
  };

  // Shared voice/transcription closures — both the export manager and AgentLab
  // need the same "silk → text" pipeline (model resolved lazily so a model
  // change between 进入 and 使用 is honoured). Factored here to avoid duplication.
  const transcribeSilk = async (
    silkPath: string,
  ): Promise<{ ok: boolean; text?: string; error?: string }> => {
    const modelId = userConfig.getSettings().voiceTranscribe.modelId;
    if (!modelId) return { ok: false, error: '未选择转录模型' };
    const model = getVoiceModel(modelId);
    if (!model) return { ok: false, error: '转录模型不存在' };
    const status = bootstrap.voiceTranscribe.getModelStatus(modelId);
    if (!status?.downloaded) return { ok: false, error: '转录模型未下载' };
    const { decodeSilkToWav16kBuffer } = await import('../voice');
    const wav = await decodeSilkToWav16kBuffer(silkPath);
    if (!wav) return { ok: false, error: '语音解码失败' };
    const paths = bootstrap.voiceTranscribe.resolveModelPaths(modelId);
    if (!paths.model || !paths.tokens) return { ok: false, error: '模型文件缺失' };
    const { transcribeWav } = await import('../transcribe/engine');
    const r = await transcribeWav(
      wav,
      { model: paths.model, tokens: paths.tokens },
      { engine: model.engine, languages: model.languages },
    );
    return r.success ? { ok: true, text: r.text ?? '' } : { ok: false, error: r.error ?? '识别失败' };
  };
  /** True only when a transcription model is configured AND downloaded. */
  const voiceReady = (): boolean => {
    const modelId = userConfig.getSettings().voiceTranscribe.modelId;
    return !!modelId && Boolean(bootstrap.voiceTranscribe.getModelStatus(modelId)?.downloaded);
  };
  /** AgentLab media deps factory: media completion + voice for a given session. */
  const agentLabMedia = (
    fileSearch: FileSearchService,
    mediaDownload: MediaDownloadService,
  ): import('@weq/service').AgentLabMediaDeps => ({
    fileSearch,
    mediaDownload,
    transcribe: transcribeSilk,
    decodeSilkToWavFile: (silk: string, dest: string) =>
      import('../voice').then((m) => m.decodeSilkToFile(silk, dest)),
    voiceReady,
  });

  const ctx: AppContext = {
    platform,
    bootstrap,
    nativeError: null,
    account: null,
    services: null,
    scheduler: null,
    async setAccount(accountCtx: AccountContext, metadata: AccountConfigMetadata = {}): Promise<void> {
      logger.info('opening account session', {
        event: 'open-account-start',
        accountUin: accountCtx.uin,
        dataDir: metadata.dataDir ?? null,
      });
      dbHealthCheckSeq += 1;
      dbHealthCheckRunning = false;
      accountMonitor?.stop();
      accountMonitor = null;
      void stopMcpServer();
      void stopWeqServer();
      setWeqStats(null); // drop the 群数据周报 snapshot so it can't leak across accounts
      void disposeExternalMcp();
      this.account?.dispose();
      dbWatchHandle?.unmount();
      dbWatchHandle = null;
      // A live query failing with a corruption-signature error is what triggers
      // the (otherwise unrun) full health check — not account-open. `this.account`
      // is only set after this resolves, so callbacks that fire mid-open (e.g.
      // the uid-map load) are ignored until the session is the current one.
      const session = await openAccount(platform, accountCtx, (info): void => {
        const current = this.account;
        if (!current) return;
        console.warn('[account] suspected database corruption from query on', info.dbPath, info.error);
        logger.warn('suspected database corruption from query', {
          event: 'suspected-db-corruption',
          accountUin: current.context.uin,
          dbPath: info.dbPath,
          error: info.error,
        });
        startDbHealthCheck(this, current, platform);
      });
      this.account = session;
      const accountConfig = new AccountConfigService(session, platform.appDataRoot());
      // Per-account export cache: tasks + outputs must NOT leak across accounts.
      // Keyed by the same (uin, dataDir) id the account record uses.
      const exportConfigId = accountConfigId(session.context.uin, metadata.dataDir);
      const resolveOnlinePid = (): number => {
        const record = accountConfig.getRecord();
        if (!record?.qqOnline || !record.qqPid) {
          throw new Error('QQ account is not online.');
        }
        return record.qqPid;
      };
      // Shared media download service — also injected into the export manager so
      // 媒体补全 reuses the same rkey-backed CDN download + on-disk cache.
      const mediaDownload = new MediaDownloadService(
        accountConfig,
        // Honour the custom 缓存路径 override (设置 → 账号信息). Applied at
        // account-open time; changing it takes effect on the next 进入.
        userConfig.cacheDir('media'),
      );
      // OIDB-backed video / file download URL resolver (needs the online QQ pid);
      // injected into the export manager for 视频 / 文件 媒体补全.
      const mediaUrl = new MediaUrlService(platform.native.ntHelper, session, resolveOnlinePid);
      // QQ 空间 Web 查询（说说 / 相册）—— 也注入进导出管理器，供「好友空间导出」
      // 翻页拉说说。需在线 QQ 凭证；离线时 fetchMsgList 会抛错（前端已先拦截）。
      const webQuery = new WebQueryService(platform.native.ntHelper, session, resolveOnlinePid);
      // Shared instances also fed to the export manager's ChatLab deps (name /
      // role / profile resolution), so they're built before the services object.
      const groupInfo = new GroupInfoService(session);
      const profile = new ProfileService(session);
      // 收藏服务：网络优先(微云 collector)、拿不到 p_skey 回退 collection.db。
      // 既进 services，又喂给导出管理器的收藏拉取 dep（拍平投影）。
      const collectionSvc = new CollectionService(platform.native.ntHelper, session, resolveOnlinePid);
      // Built before the services literal so AgentLab can reuse the same media
      // pipeline (媒体寻址 + rkey 补全) for 表情包/语音.
      const fileSearch = new FileSearchService(session, platform);
      // Shared token-accounting + conversation stores, used by BOTH the clone
      // service and the WeQ assistant so usage stats + chat history are unified.
      const agentlabRoot = userConfig.cacheDir(join('agentlab', exportConfigId));
      const tokenUsage = new TokenUsageStore(join(agentlabRoot, 'usage.json'));
      const conversations = new ConversationStore(join(agentlabRoot, 'conversations.json'));
      const resolveAgentEndpoint = (ref: import('@weq/agentlab').AgentLabModelRef) =>
        bootstrap.agentLabConfig.resolveEndpoint(ref);
      // 删除记录：哪些消息是 WeQ 删的 + 原始 40011/40012（恢复用），按账号落盘。
      const deletedMsgs = new DeletedMsgStore(
        join(userConfig.cacheDir(join('deleted', exportConfigId)), 'deleted.json'),
      );
      // 防撤回 service：既装 trigger，又是「读 weq_recall_log」的入口。先建好，
      // 供 MsgService 给消息打「撤回」标（明文直显 + 撤回者），同时进 services。
      const antiRecall = new AntiRecallService(
        session,
        platform,
        join(userConfig.cacheDir(join('anti_recall', exportConfigId)), 'config.json'),
      );
      this.services = {
        msgs: new MsgService(session, deletedMsgs, antiRecall),
        recentContacts: new RecentContactService(session),
        unreadInfo: new UnreadInfoService(session),
        accountConfig,
        forwardMsgs: new ForwardMsgService(session),
        groupInfo,
        buddyAnalytics: new BuddyAnalyticsService(session),
        groupNotify: new GroupNotifyService(session),
        profile,
        msgSearch: new MsgSearchService(session),
        onlineStatus: new OnlineStatusService(session),
        collection: collectionSvc,
        fileSearch,
        mediaDownload,
        mediaUrl,
        fileAssistant: new FileAssistantService(session),
        emoji: new EmojiService(session, platform),
        agentLab: new AgentLabService(
          session,
          agentlabRoot,
          resolveAgentEndpoint,
          // Thing 1: 注入媒体/语音能力，蒸馏期补全表情包 + 转录语音。
          agentLabMedia(fileSearch, mediaDownload),
          tokenUsage,
          conversations,
          // 语音合成（克隆体发语音 / 语音克隆）：provider 从全局语音配置取。
          {
            service: bootstrap.tts,
            getProvider: (id: string) =>
              userConfig.getSettings().voiceTranscribe.ttsProviders.find((p) => p.id === id) ?? null,
          },
        ),
        assistant: new AssistantService(agentlabRoot, resolveAgentEndpoint, tokenUsage, conversations, {
          // 内置工具 + 用户接入的外部 MCP 工具合并；外部列举是惰性异步的。
          specs: async () => [...aiToolSpecs(), ...(await getExternalMcpHub().specs())],
          run: (name, args) =>
            name.startsWith('mcp__') ? getExternalMcpHub().run(name, args) : runAiTool(name, args),
          // 配置变更/启动时把外部 MCP 配置同步给 Hub（连接惰性建立）。
          syncExternalMcp: (raw) => getExternalMcpHub().configure(raw),
          // 写报告时随机抽一批「一言」候选，供模型挑一句做主题大字（多元化）。
          sampleHitokoto,
        }),
        exportManager: new (await import('@weq/service')).ExportTaskManager(
          new MsgService(session),
          userConfig.cacheDir(join('export', exportConfigId)),
          {
            // Cache-first avatar resolution for the 导出头像 option.
            avatarCache: bootstrap.avatarCache,
            // rkey-backed CDN image completion (媒体补全).
            mediaDownload,
            // OIDB video / file download URL resolver (媒体补全 视频/文件).
            mediaUrl,
            // Account user-data dir for locating on-disk media to copy.
            accountDir: metadata.dataDir ?? accountConfig.getRecord()?.dataDir,
            // Built-in system-emoji resource dir — HTML export copies the 小黄脸
            // face images used by the conversation into the bundle so they render.
            emojiDir: platform.emojiResourceDir(session.context.uin),
            // Platform-resolved nt_data (correct per-OS; linux has no `nt_qq`
            // middle segment). Preferred over deriving it from accountDir.
            ...(platform.ntDataDir(session.context.uin)
              ? { ntDataDir: platform.ntDataDir(session.context.uin)! }
              : {}),
            // SILK → WAV decode lives in the app (silk-wasm); load it lazily to
            // avoid a static import cycle with this module.
            decodeSilk: (silk: string, dest: string) =>
              import('../voice').then((m) => m.decodeSilkToFile(silk, dest)),
            // Voice → text transcription (shared closure; see transcribeSilk above).
            transcribe: transcribeSilk,
            // ChatLab name / role / profile resolvers. The service export package
            // is account-agnostic, so the live account services are injected here.
            chatlab: {
              resolveGroupMembers: async (groupCode, uids) => {
                const members = await groupInfo.getMembersByUids(BigInt(groupCode), uids);
                return members.map((m) => ({
                  uid: m.uid,
                  uin: m.uin.toString(),
                  card: m.card,
                  nick: m.nick,
                  adminFlag: m.adminFlag,
                }));
              },
              groupMeta: async (groupCode) => {
                const detail = await groupInfo.getGroupDetail(BigInt(groupCode));
                return detail ? { name: detail.groupName, ownerUid: detail.ownerUid } : null;
              },
              resolveProfile: async (uid) => {
                const p = await profile.getProfile(uid);
                return p ? { uin: p.uin.toString(), nick: p.nick } : null;
              },
              self: async () => {
                const p = await profile.getSelfProfile();
                if (p) return { uid: p.uid, uin: p.uin.toString(), nick: p.nick };
                // No cached self profile — fall back to the session uin (uid
                // unknown; the c2c export uses uin as the platformId anyway).
                const uin = String(session.context.uin ?? '');
                return uin ? { uid: '', uin, nick: '' } : null;
              },
            },
            // 好友 QQ 空间说说导出：翻页拉取能力（需在线 QQ）。
            qzone: { fetchMsgList: (uin, pos, num) => webQuery.getQzoneMsgList(uin, pos, num) },
            // 联系人导出（好友 / 群成员）：本地资料库拉取，bigint 归一化为字符串。
            contacts: {
              listBuddies: async (limit, offset) => {
                const buddies = await profile.listBuddies(limit, offset);
                return buddies.map((b) => ({
                  uid: b.uid,
                  uin: b.uin.toString(),
                  qid: b.qid,
                  categoryId: b.categoryId,
                }));
              },
              listCategories: async () => {
                const cats = await profile.listCategories();
                return cats.map((c) => ({ id: c.id, name: c.name }));
              },
              profilesByUids: async (uids) => {
                const profiles = await profile.profilesByUids(uids);
                return profiles.map((p) => ({
                  uid: p.uid,
                  nick: p.nick,
                  remark: p.remark,
                  signature: p.signature,
                  gender: p.gender,
                  age: p.age,
                  birthYear: p.birthYear,
                  birthMonth: p.birthMonth,
                  birthDay: p.birthDay,
                  intimacy: p.intimacy,
                }));
              },
              listGroupMembers: async (groupCode, limit, offset) => {
                const members = await groupInfo.listMembersInGroup(BigInt(groupCode), limit, offset);
                return members.map((m) => ({
                  uid: m.uid,
                  uin: m.uin.toString(),
                  card: m.card,
                  nick: m.nick,
                  adminFlag: m.adminFlag,
                  customTitle: m.customTitle,
                  memberLevel: m.memberLevel,
                  joinTime: m.joinTime,
                  lastSpeakTime: m.lastSpeakTime,
                }));
              },
              groupOwnerUid: async (groupCode) => {
                const detail = await groupInfo.getGroupDetail(BigInt(groupCode));
                return detail?.ownerUid ?? null;
              },
            },
            // 收藏导出：翻页拉本地收藏并拍平为可序列化行（复用 IPC 的 wire 投影）。
            collection: {
              listCollections: async (limit, offset) => {
                const page = await collectionSvc.listCollections(limit, offset);
                return page.items.map(collectionItemToWire);
              },
            },
          },
        ),
        dbDecrypt: new DbDecryptService(session, platform),
        dbExplorer: new DbExplorerService(session, platform),
        antiRecall,
        avatarResource: new AvatarResourceService(session, platform),
        sysEmoji: new SysEmojiResourceService(session, platform),
        marketEmoji: new MarketEmojiResourceService(session, platform),
        customEmoji: new CustomEmojiResourceService(session, platform),
        relatedEmoji: new RelatedEmojiResourceService(session, platform),
        fileResource: new FileResourceService(session, platform),
        mediaResource: new MediaResourceService(session, platform),
        resourceCleanup: new ResourceCleanupService(session, platform),
        webQuery,
        groupAlbumMedia: new GroupAlbumMediaService(platform.native.ntHelper, session, resolveOnlinePid),
      };
      // Scheduled export manager — fires saved templates through the export
      // manager on a single setTimeout wake. Per-account cache mirrors the
      // export manager's isolation (see exportConfigId above). The online
      // check reads the live record at fire-time only. Held on `ctx` (not on
      // `services`) so the services object literal can stay simple and the
      // scheduler's lifecycle is independent.
      const exportManager = this.services.exportManager;
      this.scheduler = new (await import('@weq/service')).ExportScheduler(
        userConfig.cacheDir(join('export', exportConfigId)),
        {
          taskManager: exportManager,
          isOnline: () => {
            const r = accountConfig.getRecord();
            return Boolean(r?.qqOnline && r?.qqPid);
          },
        },
      );
      // Persist credentials + metadata, keyed by data directory. Must run
      // before the monitor starts so its patches land on an existing record.
      accountConfig.save(metadata);

      // Start the background login/pid monitor for this account. rkey
      // harvesting inside it is gated live by the 媒体补全 master switch, so
      // toggling that setting takes effect on the next poll without a re-open.
      // clientkey harvesting is gated by the autoFetchClientKey setting.
      accountMonitor = new AccountMonitorService(
        session,
        platform,
        accountConfig,
        () => userConfig.getSettings().mediaCompletion.enabled,
        () => userConfig.getSettings().autoFetchClientKey,
        bootstrap.injectHook,
      );
      accountMonitor.start();
      logger.info('opened account session', {
        event: 'open-account-success',
        accountUin: session.context.uin,
        dataDir: metadata.dataDir ?? null,
      });

      // Watch this account's nt_msg.db only when 实时消息 is enabled. Toggling
      // it later is handled live by `applyRealtime` (no re-open needed).
      if (userConfig.getSettings().realtimeEnabled) {
        mountDbWatch(session);
      }

      // MCP server is account-bound: only listen while an account is open.
      // Start it now if enabled; live toggling is handled by `applyMcp`.
      const mcp = userConfig.getSettings().mcp;
      if (mcp.enabled && mcp.token) {
        startMcpServer({ port: mcp.port, token: mcp.token })
          .then((boundPort) => {
            // Port fallback may have moved us off a squatted port; persist the
            // real one so the UI / client config stay in sync.
            if (boundPort !== mcp.port) userConfig.setSettings({ mcp: { port: boundPort } });
          })
          .catch((error) => {
            logger.error('failed to start mcp server on account open', {
              event: 'mcp-start-failed',
              port: mcp.port,
              ...logErrorContext(error),
            });
          });
      }

      // WeQ 助手 is account-bound too: ensure the fabricated conversation exists
      // + start the loopback server when enabled. Live toggling → applyWeqAssistant.
      const weq = userConfig.getSettings().weqAssistant;
      if (weq.enabled) {
        void this.applyWeqAssistant(weq).catch((error) => {
          logger.error('failed to start weq assistant on account open', {
            event: 'weq-start-failed',
            port: weq.port,
            ...logErrorContext(error),
          });
        });
      }
      // No health check at open — it now runs lazily, only if a real query
      // later fails in a way that looks like corruption (see the openAccount
      // callback above).
    },
    async setStaticAccount(
      dirPath: string,
      selfPreview: { uin: string; displayName: string; avatarUrl: string },
      options: { dbKey?: string; algo?: import('@weq/native').DatabaseAlgorithms } = {},
    ): Promise<void> {
      logger.info('opening static account session', {
        event: 'open-static-account-start',
        accountUin: selfPreview.uin,
        dirPath,
      });
      dbHealthCheckSeq += 1;
      dbHealthCheckRunning = false;
      accountMonitor?.stop();
      accountMonitor = null;
      void stopMcpServer();
      void stopWeqServer();
      setWeqStats(null); // drop the 群数据周报 snapshot so it can't leak across accounts
      void disposeExternalMcp();
      this.account?.dispose();
      dbWatchHandle?.unmount();
      dbWatchHandle = null;
      this.scheduler?.stop();
      this.scheduler = null;

      // Static (backup) accounts are offline snapshots, not the live QQ
      // database — no corruption watch is wired (openStaticAccount uses the raw
      // binding) and no health check is ever triggered.
      const session = await openStaticAccount(platform, {
        dirPath,
        self: { uin: selfPreview.uin, nick: selfPreview.displayName, avatarUrl: selfPreview.avatarUrl, uid: '' },
        ...(options.dbKey ? { dbKey: options.dbKey } : {}),
        ...(options.algo ? { algo: options.algo } : {}),
      });
      this.account = session;

      const accountConfig = new AccountConfigService(session, platform.appDataRoot());
      const exportConfigId = accountConfigId(session.context.uin, dirPath);

      // Live QQ is not available for static accounts — PID-dependent services
      // will simply fail gracefully when called.
      const noPid = (): number => {
        throw new Error('QQ account is not online (static account — offline mode).');
      };

      const mediaDownload = new MediaDownloadService(
        accountConfig,
        userConfig.cacheDir('media'),
      );
      const mediaUrl = new MediaUrlService(platform.native.ntHelper, session, noPid);
      // 静态账号无在线 QQ —— webQuery 用 noPid，「好友空间导出」会优雅失败（离线）。
      const webQuery = new WebQueryService(platform.native.ntHelper, session, noPid);
      const groupInfo = new GroupInfoService(session);
      const profile = new ProfileService(session);
      // 收藏服务：静态账号 noPid 会让网络路径拿不到 p_skey → 自动回退 collection.db。
      const collectionSvc = new CollectionService(platform.native.ntHelper, session, noPid);
      const fileSearch = new FileSearchService(session, platform);
      const agentlabRoot = userConfig.cacheDir(join('agentlab', exportConfigId));
      const tokenUsage = new TokenUsageStore(join(agentlabRoot, 'usage.json'));
      const conversations = new ConversationStore(join(agentlabRoot, 'conversations.json'));
      const resolveAgentEndpoint = (ref: import('@weq/agentlab').AgentLabModelRef) =>
        bootstrap.agentLabConfig.resolveEndpoint(ref);
      // 删除记录：与在线会话同一份存储（按 exportConfigId 落盘），静态账号也可删/恢复。
      const deletedMsgs = new DeletedMsgStore(
        join(userConfig.cacheDir(join('deleted', exportConfigId)), 'deleted.json'),
      );
      // 防撤回 service：装 trigger + 读 weq_recall_log。先建好供 MsgService 打撤回标。
      const antiRecall = new AntiRecallService(
        session,
        platform,
        join(userConfig.cacheDir(join('anti_recall', exportConfigId)), 'config.json'),
      );

      this.services = {
        msgs: new MsgService(session, deletedMsgs, antiRecall),
        recentContacts: new RecentContactService(session),
        unreadInfo: new UnreadInfoService(session),
        accountConfig,
        forwardMsgs: new ForwardMsgService(session),
        groupInfo,
        buddyAnalytics: new BuddyAnalyticsService(session),
        groupNotify: new GroupNotifyService(session),
        profile,
        msgSearch: new MsgSearchService(session),
        onlineStatus: new OnlineStatusService(session),
        collection: collectionSvc,
        fileSearch,
        mediaDownload,
        mediaUrl,
        fileAssistant: new FileAssistantService(session),
        emoji: new EmojiService(session, platform),
        agentLab: new AgentLabService(
          session,
          agentlabRoot,
          resolveAgentEndpoint,
          // 静态账号也注入：媒体寻址可能命中不到（无 nt_data），会优雅降级。
          agentLabMedia(fileSearch, mediaDownload),
          tokenUsage,
          conversations,
          {
            service: bootstrap.tts,
            getProvider: (id: string) =>
              userConfig.getSettings().voiceTranscribe.ttsProviders.find((p) => p.id === id) ?? null,
          },
        ),
        assistant: new AssistantService(agentlabRoot, resolveAgentEndpoint, tokenUsage, conversations, {
          // 内置工具 + 用户接入的外部 MCP 工具合并；外部列举是惰性异步的。
          specs: async () => [...aiToolSpecs(), ...(await getExternalMcpHub().specs())],
          run: (name, args) =>
            name.startsWith('mcp__') ? getExternalMcpHub().run(name, args) : runAiTool(name, args),
          // 配置变更/启动时把外部 MCP 配置同步给 Hub（连接惰性建立）。
          syncExternalMcp: (raw) => getExternalMcpHub().configure(raw),
          // 写报告时随机抽一批「一言」候选，供模型挑一句做主题大字（多元化）。
          sampleHitokoto,
        }),
        exportManager: new (await import('@weq/service')).ExportTaskManager(
          new MsgService(session),
          userConfig.cacheDir(join('export', exportConfigId)),
          {
            avatarCache: bootstrap.avatarCache,
            mediaDownload,
            mediaUrl,
            // For static accounts, the data directory IS the decrypted DB
            // directory. nt_data media subdirectories won't be present, so
            // media-copy will skip gracefully and only CDN completion would
            // work (which requires a live QQ — unavailable here).
            accountDir: dirPath,
            // Built-in system-emoji resource dir (may be absent for a static
            // account — HTML export then skips face images gracefully).
            emojiDir: platform.emojiResourceDir(session.context.uin),
            decodeSilk: (silk: string, dest: string) =>
              import('../voice').then((m) => m.decodeSilkToFile(silk, dest)),
            transcribe: transcribeSilk,
            chatlab: {
              resolveGroupMembers: async (groupCode, uids) => {
                const members = await groupInfo.getMembersByUids(BigInt(groupCode), uids);
                return members.map((m) => ({
                  uid: m.uid,
                  uin: m.uin.toString(),
                  card: m.card,
                  nick: m.nick,
                  adminFlag: m.adminFlag,
                }));
              },
              groupMeta: async (groupCode) => {
                const detail = await groupInfo.getGroupDetail(BigInt(groupCode));
                return detail ? { name: detail.groupName, ownerUid: detail.ownerUid } : null;
              },
              resolveProfile: async (uid) => {
                const p = await profile.getProfile(uid);
                return p ? { uin: p.uin.toString(), nick: p.nick } : null;
              },
              self: async () => {
                const p = await profile.getSelfProfile();
                if (p) return { uid: p.uid, uin: p.uin.toString(), nick: p.nick };
                const uin = String(session.context.uin ?? '');
                return uin ? { uid: '', uin, nick: '' } : null;
              },
            },
            qzone: { fetchMsgList: (uin, pos, num) => webQuery.getQzoneMsgList(uin, pos, num) },
            // 收藏导出：静态账号同样有本地收藏库，可离线导出。
            collection: {
              listCollections: async (limit, offset) => {
                const page = await collectionSvc.listCollections(limit, offset);
                return page.items.map(collectionItemToWire);
              },
            },
          },
        ),
        dbDecrypt: new DbDecryptService(session, platform),
        dbExplorer: new DbExplorerService(session, platform),
        antiRecall,
        avatarResource: new AvatarResourceService(session, platform),
        sysEmoji: new SysEmojiResourceService(session, platform),
        marketEmoji: new MarketEmojiResourceService(session, platform),
        customEmoji: new CustomEmojiResourceService(session, platform),
        relatedEmoji: new RelatedEmojiResourceService(session, platform),
        fileResource: new FileResourceService(session, platform),
        mediaResource: new MediaResourceService(session, platform),
        resourceCleanup: new ResourceCleanupService(session, platform),
        webQuery,
        groupAlbumMedia: new GroupAlbumMediaService(platform.native.ntHelper, session, noPid),
      };

      // Persist metadata keyed by the decrypted-db directory, so re-opening
      // works without re-selecting the folder. `static: true` is the marker
      // the account-list badge + re-open path look for.
      accountConfig.save({
        dataDir: dirPath,
        static: true,
        ...(selfPreview.displayName ? { displayName: selfPreview.displayName } : {}),
        ...(selfPreview.avatarUrl ? { avatarUrl: selfPreview.avatarUrl } : {}),
      });
      logger.info('opened static account session', {
        event: 'open-static-account-success',
        accountUin: session.context.uin,
        dirPath,
      });

      // No monitor, no db watch, no health check, no scheduler —
      // static accounts are offline snapshots.
    },
    clearAccount(): void {
      logger.info('clearing account session', {
        event: 'clear-account',
        accountUin: this.account?.context.uin ?? null,
      });
      dbHealthCheckSeq += 1;
      dbHealthCheckRunning = false;
      accountMonitor?.stop();
      accountMonitor = null;
      // Tear down the scheduler's wake timer before dropping the services
      // object — otherwise a late tick would call into a disposed
      // ExportTaskManager.
      this.scheduler?.stop();
      this.scheduler = null;
      void stopMcpServer();
      void stopWeqServer();
      setWeqStats(null); // drop the 群数据周报 snapshot so it can't leak across accounts
      void disposeExternalMcp();
      unmountDbWatch();
      this.account?.dispose();
      this.account = null;
      this.services = null;
    },
    applyRealtime(enabled: boolean): void {
      const session = this.account;
      if (!session) return;
      logger.info('toggled realtime db watch', {
        event: 'apply-realtime',
        accountUin: session.context.uin,
        enabled,
      });
      if (enabled) mountDbWatch(session);
      else unmountDbWatch();
    },
    async applyMcp(config: McpServerConfig): Promise<void> {
      // Only live accounts host the MCP server. With no account open we just
      // persist (handled by the caller) and start lazily on next account open.
      if (!this.account || !this.services) {
        await stopMcpServer();
        return;
      }
      logger.info('applying mcp server config', {
        event: 'apply-mcp',
        accountUin: this.account.context.uin,
        enabled: config.enabled,
        port: config.port,
      });
      if (config.enabled && config.token) {
        const boundPort = await startMcpServer({ port: config.port, token: config.token });
        // Port fallback may have moved us off a squatted port; persist the real
        // one so getMcpStatus / the client config snippet report what's live.
        if (boundPort !== config.port) userConfig.setSettings({ mcp: { port: boundPort } });
      } else {
        await stopMcpServer();
      }
    },
    async applyWeqAssistant(config: WeqAssistantConfig): Promise<number> {
      // Only live accounts host the server / own the fabricated conversation.
      if (!this.account || !this.platform) {
        await stopWeqServer();
        return 0;
      }
      logger.info('applying weq assistant config', {
        event: 'apply-weq-assistant',
        accountUin: this.account.context.uin,
        enabled: config.enabled,
        port: config.port,
      });
      const svc = new WeqAssistantService(this.account, this.platform, userConfig.getWeqAssistantUid());

      // 关闭：停 server + 只删会话列表行（recent_contact）。mapping / c2c 一概保留——
      // 推文（消息）与身份目录留在库里，下次开启对比本地补齐即可。best-effort。
      if (!config.enabled) {
        await stopWeqServer();
        try {
          await svc.removeContact();
        } catch (error) {
          logger.warn('failed to remove weq assistant contact on disable', {
            event: 'weq-disable-failed',
            ...logErrorContext(error),
          });
        }
        return 0;
      }

      // 1) Start the loopback server (port fallback may move us up).
      const boundPort = await startWeqServer({ port: config.port });

      // 2) 本地推文列表是唯一数据源：读本地（首次为空则种入内置两篇，时间固定在本地），
      //    再 syncTweets——ensureMapping（只写一次）+ 逐条按固定时间去重补进 c2c（只新增
      //    不删除）+ 把已有卡片端口刷成当前实际端口（改写≠删除）+ 会话列表预览最新一篇。
      //    best-effort：log but don't crash the toggle.
      try {
        const storePath = tweetsStorePath(userConfig.cacheDir('weq-assistant'));
        const tweets = ensureDefaultTweets(storePath);
        const logo = resolveResource('brand', 'logo.png') ?? undefined;
        await svc.syncTweets(boundPort, tweets, logo);
        userConfig.setSettings({ weqAssistant: { port: boundPort } });
      } catch (error) {
        logger.error('failed to sync weq assistant tweets', {
          event: 'weq-ensure-failed',
          ...logErrorContext(error),
        });
      }

      // 「群数据周报」推文的存储/缓存：后台（非阻塞）挑「我等级最高的群」算一份统计
      // 快照并落盘，页面（/p/stats）只读这份缓存。best-effort：失败只记日志。首帧会先
      // 把盘上旧缓存灌进内存，避免推文空窗（见 weq_assistant/stats.refreshWeqStats）。
      if (this.services) {
        const statsUin = this.account.context.uin;
        const cachePath = statsCachePath(userConfig.cacheDir('weq-assistant'), statsUin);
        void refreshWeqStats(this.services.groupInfo, statsUin, cachePath).catch((error) => {
          logger.warn('failed to refresh weq stats snapshot', {
            event: 'weq-stats-refresh-failed',
            ...logErrorContext(error),
          });
        });
      }
      // No svc.close() — it shares the session's cached nt_msg.db connection.
      return boundPort;
    },
    refreshRkeysNow(): Promise<boolean> {
      logger.info('manual rkey refresh requested', {
        event: 'refresh-rkeys-now',
        accountUin: this.account?.context.uin ?? null,
      });
      return accountMonitor?.harvestRkeysNow() ?? Promise.resolve(false);
    },
  };

  cached = ctx;
  return ctx;
}

/**
 * Accessor used by tRPC handlers / IPC. Throws if called before
 * `initAppContext()` — which would be a startup-ordering bug.
 */
export function getAppContext(): AppContext {
  if (!cached) {
    throw new Error('AppContext not initialized — call initAppContext() in main first.');
  }
  return cached;
}

/** Bootstrap services, asserting native loaded. Throws a friendly error otherwise. */
export function requireBootstrap(): BootstrapServices {
  const ctx = getAppContext();
  if (!ctx.bootstrap) {
    throw new Error('Native bundle unavailable — QQ helper failed to initialize.');
  }
  return ctx.bootstrap;
}

/** Platform handle, asserting native loaded. */
export function requirePlatform(): Platform {
  const ctx = getAppContext();
  if (!ctx.platform) {
    throw new Error('Native bundle unavailable — QQ helper failed to initialize.');
  }
  return ctx.platform;
}

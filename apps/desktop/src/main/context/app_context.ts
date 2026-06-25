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
import { join } from 'node:path';
import { loadNativeSafe } from '@weq/native';
import { createWin32Platform, type Platform } from '@weq/platform';
import {
  accountConfigId,
  UserConfigService,
  Win32DetectService,
  Win32KeyService,
  GlobalConfigService,
  AvatarCacheService,
  VoiceTranscribeService,
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
  GroupNotifyService,
  ProfileService,
  FileAssistantService,
  FileSearchService,
  EmojiService,
  MsgSearchService,
  OnlineStatusService,
  DbDecryptService,
  WebQueryService,
  GroupAlbumMediaService,
  DbWatchService,
  checkAccountDatabaseHealth,
  createNtMsgDbHook,
  formatDbHealthFailures,
  type AccountConfigMetadata,
  type DbWatchHandle,
  type NewMessages,
  type DbChange,
  type DbHealthFailure,
} from '@weq/service';
import { openAccount, openStaticAccount, peekStaticSelfUin, type AccountContext, type AccountSession } from '@weq/account';

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

export const accountEventBus = new EventEmitter();

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

function startDbHealthCheck(ctx: AppContext, session: AccountSession, platform: Platform): void {
  const seq = ++dbHealthCheckSeq;
  void (async (): Promise<void> => {
    const failures = await checkAccountDatabaseHealth(session, platform);
    // 没检出损坏就不弹窗、不强退。
    if (failures.length === 0) return;
    // A newer check started or the account changed mid-check — drop this result.
    if (seq !== dbHealthCheckSeq || ctx.account !== session) return;

    const details = formatDbHealthFailures(failures);
    ctx.clearAccount();
    accountEventBus.emit('forcedClosed', {
      reason: 'database-damaged',
      title: '数据库损坏',
      message:
        '检测到 QQ 数据库损坏，问题出在 QQ 数据库本身，不是 WeQ 软件导致。账号已强制退出并返回主页面。可以去 https://github.com/H3CoF6/WeQ/issues 提 issue，未来可能会做一个数据库修复工具。',
      details,
      failures,
    } satisfies AccountForcedClosedEvent);
  })().catch((e) => {
    if (seq !== dbHealthCheckSeq || ctx.account !== session) return;
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
  });
}

export interface BootstrapServices {
  detect: Win32DetectService;
  keys: Win32KeyService;
  userConfig: UserConfigService;
  globalConfig: GlobalConfigService;
  avatarCache: AvatarCacheService;
  /** Voice-transcription model management (download/select). Account-independent. */
  voiceTranscribe: VoiceTranscribeService;
}

/** Services that are re-created whenever an account session opens. */
export interface AccountServices {
  msgs: MsgService;
  recentContacts: RecentContactService;
  unreadInfo: UnreadInfoService;
  accountConfig: AccountConfigService;
  forwardMsgs: ForwardMsgService;
  groupInfo: GroupInfoService;
  groupNotify: GroupNotifyService;
  profile: ProfileService;
  msgSearch: MsgSearchService;
  onlineStatus: OnlineStatusService;
  /** Locate on-disk media (pic/video/ptt/file) for the media protocol. */
  fileSearch: FileSearchService;
  /** CDN fallback download for media missing on disk (uses live rkeys). */
  mediaDownload: MediaDownloadService;
  /** Search file entries by msgId or name. */
  fileAssistant: FileAssistantService;
  /** Decrypt + cache market-face (store sticker) images. */
  emoji: EmojiService;
  /** Export task manager. */
  exportManager: import('@weq/service').ExportTaskManager;
  /** List and bulk-decrypt encrypted QQ NT databases. */
  dbDecrypt: DbDecryptService;
  /** Web CGI queries that need the already-hooked online QQ process. */
  webQuery: WebQueryService;
  /** Group album media listing over the already-hooked online QQ process. */
  groupAlbumMedia: GroupAlbumMediaService;
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
      refreshRkeysNow(): Promise<boolean> {
        return Promise.resolve(false);
      },
    };
    return cached;
  }

  const platform = createWin32Platform(result.bundle);
  const userConfig = new UserConfigService(platform);

  const bootstrap: BootstrapServices = {
    detect: new Win32DetectService(platform),
    keys: new Win32KeyService(platform),
    userConfig,
    globalConfig: new GlobalConfigService(platform, userConfig),
    avatarCache: new AvatarCacheService(platform, userConfig),
    voiceTranscribe: new VoiceTranscribeService(platform),
  };

  const ctx: AppContext = {
    platform,
    bootstrap,
    nativeError: null,
    account: null,
    services: null,
    scheduler: null,
    async setAccount(accountCtx: AccountContext, metadata: AccountConfigMetadata = {}): Promise<void> {
      dbHealthCheckSeq += 1;
      accountMonitor?.stop();
      accountMonitor = null;
      this.account?.dispose();
      dbWatchHandle?.unmount();
      dbWatchHandle = null;
      const session = await openAccount(platform, accountCtx);
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
      // Shared instances also fed to the export manager's ChatLab deps (name /
      // role / profile resolution), so they're built before the services object.
      const groupInfo = new GroupInfoService(session);
      const profile = new ProfileService(session);
      this.services = {
        msgs: new MsgService(session),
        recentContacts: new RecentContactService(session),
        unreadInfo: new UnreadInfoService(session),
        accountConfig,
        forwardMsgs: new ForwardMsgService(session),
        groupInfo,
        groupNotify: new GroupNotifyService(session),
        profile,
        msgSearch: new MsgSearchService(session),
        onlineStatus: new OnlineStatusService(session),
        fileSearch: new FileSearchService(session, platform),
        mediaDownload,
        fileAssistant: new FileAssistantService(session),
        emoji: new EmojiService(session, platform),
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
            // SILK → WAV decode lives in the app (silk-wasm); load it lazily to
            // avoid a static import cycle with this module.
            decodeSilk: (silk: string, dest: string) =>
              import('../voice').then((m) => m.decodeSilkToFile(silk, dest)),
            // Voice → text transcription. The sherpa-onnx engine is native and
            // lives in the app; the closure resolves the selected model lazily
            // (so a model change between 进入 and 导出 is honoured) and decodes
            // the silk to 16 kHz WAV before forking the recognizer worker.
            transcribe: async (silkPath: string) => {
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
              return r.success
                ? { ok: true, text: r.text ?? '' }
                : { ok: false, error: r.error ?? '识别失败' };
            },
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
          },
        ),
        dbDecrypt: new DbDecryptService(session, platform),
        webQuery: new WebQueryService(platform.native.ntHelper, session, resolveOnlinePid),
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
      );
      accountMonitor.start();

      // Watch this account's nt_msg.db only when 实时消息 is enabled. Toggling
      // it later is handled live by `applyRealtime` (no re-open needed).
      if (userConfig.getSettings().realtimeEnabled) {
        mountDbWatch(session);
      }
      setTimeout(() => startDbHealthCheck(this, session, platform), 0);
    },
    async setStaticAccount(
      dirPath: string,
      selfPreview: { uin: string; displayName: string; avatarUrl: string },
      options: { dbKey?: string; algo?: import('@weq/native').DatabaseAlgorithms } = {},
    ): Promise<void> {
      dbHealthCheckSeq += 1;
      accountMonitor?.stop();
      accountMonitor = null;
      this.account?.dispose();
      dbWatchHandle?.unmount();
      dbWatchHandle = null;
      this.scheduler?.stop();
      this.scheduler = null;

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
      const groupInfo = new GroupInfoService(session);
      const profile = new ProfileService(session);

      this.services = {
        msgs: new MsgService(session),
        recentContacts: new RecentContactService(session),
        unreadInfo: new UnreadInfoService(session),
        accountConfig,
        forwardMsgs: new ForwardMsgService(session),
        groupInfo,
        groupNotify: new GroupNotifyService(session),
        profile,
        msgSearch: new MsgSearchService(session),
        onlineStatus: new OnlineStatusService(session),
        fileSearch: new FileSearchService(session, platform),
        mediaDownload,
        fileAssistant: new FileAssistantService(session),
        emoji: new EmojiService(session, platform),
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
            decodeSilk: (silk: string, dest: string) =>
              import('../voice').then((m) => m.decodeSilkToFile(silk, dest)),
            transcribe: async (silkPath: string) => {
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
              return r.success
                ? { ok: true, text: r.text ?? '' }
                : { ok: false, error: r.error ?? '识别失败' };
            },
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
          },
        ),
        dbDecrypt: new DbDecryptService(session, platform),
        webQuery: new WebQueryService(platform.native.ntHelper, session, noPid),
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

      // No monitor, no db watch, no health check, no scheduler —
      // static accounts are offline snapshots.
    },
    clearAccount(): void {
      dbHealthCheckSeq += 1;
      accountMonitor?.stop();
      accountMonitor = null;
      // Tear down the scheduler's wake timer before dropping the services
      // object — otherwise a late tick would call into a disposed
      // ExportTaskManager.
      this.scheduler?.stop();
      this.scheduler = null;
      unmountDbWatch();
      this.account?.dispose();
      this.account = null;
      this.services = null;
    },
    applyRealtime(enabled: boolean): void {
      const session = this.account;
      if (!session) return;
      if (enabled) mountDbWatch(session);
      else unmountDbWatch();
    },
    refreshRkeysNow(): Promise<boolean> {
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

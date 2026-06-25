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
import {
  accountEventBus,
  getAppContext,
  requireBootstrap,
  requirePlatform,
  type AccountForcedClosedEvent,
} from '../../context/app_context';
import { procedure, router } from '../trpc';
import { accountConfigId, type KeyEvent, type VoiceDownloadProgress } from '@weq/service';
import { peekStaticSelfUin } from '@weq/account';

const algoSchema = z.object({
  pageHmacAlgorithm: z.string(),
  kdfHmacAlgorithm: z.string(),
});

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

  // ---- filesystem dialog (Tencent Files fallback / manual db pick) ----

  pickTencentFilesRoot: procedure.mutation(async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 Tencent Files 目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const picked = result.filePaths[0] ?? null;
    if (picked) {
      requireBootstrap().globalConfig.setTencentFilesRootOverride(picked);
    }
    return picked;
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
      // Ensure the hook is loaded before requestDecryptKey runs.
      await platform.native.ntHelper.injectAndGetStatusEmbedded(input.pid);
      return requireBootstrap().keys.fetchFromInstance(input.pid, input.dbPath);
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

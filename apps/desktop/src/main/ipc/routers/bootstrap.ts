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
import { dialog } from 'electron';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAppContext,
  requireBootstrap,
  requirePlatform,
} from '../../context/app_context';
import { procedure, router } from '../trpc';
import { accountConfigId, type KeyEvent } from '@weq/service';

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

      ctx.setAccount(
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

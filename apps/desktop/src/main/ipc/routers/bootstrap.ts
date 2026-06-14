/**
 * Bootstrap router — services usable before any account is selected.
 *
 *   - install/process/account detection
 *   - dbkey acquisition (3 flows)
 *   - filesystem dialog for "browse to Tencent Files" fallback
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
import { getAppContext } from '../../context/app_context';
import { procedure, router } from '../trpc';
import type { KeyEvent } from '@weq/service';

export const bootstrapRouter = router({
  // ---- detection ----

  describeInstall: procedure.query(() => {
    return getAppContext().bootstrap.detect.describeInstall();
  }),

  listAccounts: procedure.query(() => {
    return getAppContext().bootstrap.detect.listAccounts();
  }),

  detectRunningProcesses: procedure.query(() => {
    return getAppContext().bootstrap.detect.detectRunningProcesses();
  }),

  // ---- user config ----

  readConfig: procedure.query(() => {
    return getAppContext().bootstrap.userConfig.read();
  }),

  listAccountConfigs: procedure.query(() => {
    return getAppContext().bootstrap.userConfig.listAccountConfigs();
  }),

  deleteAccountConfig: procedure
    .input(z.object({ uin: z.string() }))
    .mutation(({ input }) => {
      getAppContext().bootstrap.userConfig.deleteAccountConfig(input.uin);
      return true;
    }),

  // ---- filesystem dialog (Tencent Files fallback / manual db pick) ----

  pickTencentFilesRoot: procedure.mutation(async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select Tencent Files folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  }),

  pickMsgDb: procedure.mutation(async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select nt_msg.db',
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  }),

  // ---- key flows ----

  /**
   * Flow 1 — alive QQ instance. Caller passes pid + dbPath; we inject the
   * embedded hook (idempotent inside native), then ask for the key.
   */
  fetchKeyFromInstance: procedure
    .input(z.object({ pid: z.number().int().positive(), dbPath: z.string() }))
    .mutation(async ({ input }) => {
      const ctx = getAppContext();
      // Ensure the hook is loaded before requestDecryptKey runs.
      await ctx.platform.native.ntHelper.injectAndGetStatusEmbedded(input.pid);
      return ctx.bootstrap.keys.fetchFromInstance(input.pid, input.dbPath);
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
        const stream = getAppContext().bootstrap.keys.quickLoginStream({
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
        const stream = getAppContext().bootstrap.keys.qrLoginStream({
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
   * Open an account session. Caller supplies the uin + dbkey and (optionally)
   * a dbPath override — if absent, platform.ntMsgDbPath(uin) is used.
   * Returns true on success; throws (so the renderer sees an error) when
   * the dbPath doesn't exist on disk.
   */
  openAccount: procedure
    .input(
      z.object({
        uin: z.string(),
        dbKey: z.string(),
        dbPathOverride: z.string().optional(),
        algo: z.object({
          pageHmacAlgorithm: z.string(),
          kdfHmacAlgorithm: z.string()
        }).optional()
      }),
    )
    .mutation(async ({ input }) => {
      const ctx = getAppContext();
      if (input.dbPathOverride) {
        if (!existsSync(input.dbPathOverride)) {
          throw new Error(`dbPathOverride does not exist: ${input.dbPathOverride}`);
        }
        throw new Error('dbPathOverride is not yet supported — pick the uin path');
      }

      let algo = input.algo;

      // If algo is not provided, probe it using ntMsgDbPath
      if (!algo) {
        const msgDbPath = ctx.platform.ntMsgDbPath(input.uin);
        if (!msgDbPath) {
          throw new Error(`nt_msg.db not found for uin=${input.uin}`);
        }
        const probe = await ctx.platform.native.ntHelper.testDatabaseKey(msgDbPath, input.dbKey);
        if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
          throw new Error('Database key is incorrect or algorithm probing failed.');
        }
        algo = {
          pageHmacAlgorithm: probe.pageHmacAlgorithm,
          kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
        };
      }

      ctx.setAccount({ uin: input.uin, dbKey: input.dbKey, algo });
      return ctx.account!.context;
    }),

  closeAccount: procedure.mutation(() => {
    getAppContext().clearAccount();
    return true;
  }),

  /** True if an account session is currently open. Used by the renderer
   *  to decide whether to show the main view or the bootstrap view. */
  accountOpen: procedure.query(() => {
    return getAppContext().account !== null;
  }),
});

// Sanity helper — kept exported so consumers can guard against junk paths
// from the dialog without re-importing fs everywhere.
export function tencentFilesLooksReal(root: string): boolean {
  return existsSync(join(root, 'nt_qq')) || existsSync(join(root));
}

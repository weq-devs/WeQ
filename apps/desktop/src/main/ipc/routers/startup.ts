import { z } from 'zod';
import { procedure, router } from '../trpc';
import { bootstrapRouter } from './bootstrap';
import { accountRouter } from './account';
import { runtimeMaintenance } from '../../runtime_maintenance';

/** 复用原有读取，恢复交接未完成时不触碰账号；非必要读取失败仍交给原查询处理。 */
export const startupRouter = router({
  snapshot: procedure
    .input(z.object({ clientId: z.string().uuid().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const boot = bootstrapRouter.createCaller(ctx);
      const backup = await boot.backupStartup(input);
      if (
        !backup.ok ||
        backup.result?.clientPending ||
        runtimeMaintenance.status().state !== 'ready'
      )
        return { backup, snapshot: null };
      const [native, current, settings] = await Promise.all([
        boot.nativeStatus(),
        boot.currentAccount(),
        boot.getSettings(),
      ]);
      const config =
        current && !native
          ? await accountRouter
              .createCaller(ctx)
              .getAccountConfig()
              .catch(() => undefined)
          : undefined;
      const home =
        !current && !native
          ? await Promise.all([
              boot.describeInstall().catch(() => undefined),
              boot.listAccountConfigs().catch(() => undefined),
              boot.getAutoEnter({ startup: false }).catch(() => undefined),
            ])
          : null;
      return { backup, snapshot: { native, current, settings, config, home } };
    }),
});

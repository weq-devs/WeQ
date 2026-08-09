/**
 * `account.antiRecall.*` — the anti-recall settings surface.
 *
 * Thin tRPC skin over {@link AntiRecallService} (see `@weq/service`): the config
 * persistence + SQL-trigger install/drop all live there. The renderer's 设置 →
 * 防撤回 panel drives it:
 *   getStatus    → { enabled, targets, installed, qqRunning }
 *   setEnabled   → flip master switch, (re)install or drop triggers
 *   setTargets   → replace the protected-conversation set, reconcile triggers
 *
 * `setEnabled` / `setTargets` install or drop the triggers right away, whether
 * or not QQ is running. If QQ is open it may keep serving from its cached schema
 * until the next restart, so `getStatus().qqRunning` lets the UI warn that the
 * change may not take effect until QQ is restarted.
 */

import { z } from 'zod';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

/**
 * Anti-recall only means something against databases a live QQ (or a writable
 * Android backup) writes to. A PC-snapshot static account's databases are a
 * dead read-only copy, so refuse rather than write dead SQL the user believes
 * is protecting them. Android backup accounts (accountIsAndroidBackup) are
 * writable, so they are allowed through.
 */
function refuseWhenStatic(): void {
  const ctx = getAppContext();
  if (ctx.accountIsStatic && !ctx.accountIsAndroidBackup) {
    throw new Error('静态账号的数据库是离线快照，QQ 不会写入，防撤回无法生效。');
  }
}

const target = z.object({
  kind: z.enum(['c2c', 'group', 'dataline']),
  id: z.string().min(1),
});

export const antiRecallRouter = router({
  /** Current config + live trigger state + whether QQ is running. */
  getStatus: procedure.query(() => {
    return requireServices().antiRecall.getStatus();
  }),

  /** Turn the feature on/off. Installs or drops triggers to match. */
  setEnabled: procedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      // Disabling stays allowed: a snapshot imported from a machine that had
      // triggers installed must still be able to drop them.
      if (input.enabled) refuseWhenStatic();
      return requireServices().antiRecall.setEnabled(input.enabled);
    }),

  /** Replace the set of conversations protected from recall. */
  setTargets: procedure
    .input(z.object({ targets: z.array(target) }))
    .mutation(({ input }) => {
      refuseWhenStatic();
      return requireServices().antiRecall.setTargets(input.targets);
    }),
});

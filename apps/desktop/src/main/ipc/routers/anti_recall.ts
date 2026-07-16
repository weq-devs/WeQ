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
 * `setEnabled` / `setTargets` can throw AntiRecallQqRunningError (code
 * 'QQ_RUNNING') when QQ is still open — the config is persisted either way, the
 * error just tells the UI to prompt "close QQ, then retry".
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
      return requireServices().antiRecall.setEnabled(input.enabled);
    }),

  /** Replace the set of conversations protected from recall. */
  setTargets: procedure
    .input(z.object({ targets: z.array(target) }))
    .mutation(({ input }) => {
      return requireServices().antiRecall.setTargets(input.targets);
    }),
});

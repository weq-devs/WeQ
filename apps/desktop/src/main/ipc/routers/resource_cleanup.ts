/**
 * `account.resourceCleanup.*` — the 本地资源整理 → 清理释放 backend.
 *
 * Thin tRPC skin over `ResourceCleanupService` (see `@weq/service`): list the
 * deletable nt_data resource trees with their on-disk sizes, and execute a batch
 * of cleanup instructions. All whitelist / containment safety lives in the
 * service — this layer only shapes input. Destructive; account-bound.
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

export const resourceCleanupRouter = router({
  /** Per-target on-disk size (files/bytes + ori/thumb split). Slow — stats every file. */
  listTargets: procedure.query(() => {
    return requireServices().resourceCleanup.listTargets();
  }),

  /**
   * Delete the given targets. `variant`: 'all' wipes the whole tree, 'ori'/'thumb'
   * only removes original / preview files (ignored for non-split targets). Unknown
   * ids are silently dropped by the service's whitelist.
   */
  cleanup: procedure
    .input(
      z.object({
        instructions: z.array(
          z.object({
            id: z.string().min(1),
            variant: z.enum(['all', 'ori', 'thumb']),
          }),
        ),
      }),
    )
    .mutation(({ input }) => {
      return requireServices().resourceCleanup.cleanup(input.instructions);
    }),
});

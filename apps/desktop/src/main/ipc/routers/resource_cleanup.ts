/**
 * `account.resourceCleanup.*` — the 本地资源整理 → 清理释放 backend.
 *
 * Thin tRPC skin over `ResourceCleanupService` (see `@weq/service`): list the
 * deletable nt_data resource trees with their on-disk sizes, and execute a batch
 * of cleanup instructions. All whitelist / containment safety lives in the
 * service — this layer only shapes input. Destructive; account-bound.
 */

import { z } from 'zod';
import { getAppContext } from '../../context/app_context';
import { procedure, router } from '../trpc';
import {
  resourceSourceInput,
  requireResourceSource,
  assertResourceSource,
} from './resource_source';

export const resourceCleanupRouter = router({
  /** Per-target on-disk size (files/bytes + ori/thumb split). Slow — stats every file. */
  listTargets: procedure.input(resourceSourceInput.optional()).query(async ({ input }) => {
    const services = requireResourceSource(input);
    const targets = await services.resourceCleanup.listTargets();
    assertResourceSource(services, input);
    return targets;
  }),

  /**
   * Delete the given targets. `variant`: 'all' wipes the whole tree, 'ori'/'thumb'
   * only removes original / preview files (ignored for non-split targets). Unknown
   * ids are silently dropped by the service's whitelist.
   */
  cleanup: procedure
    .input(
      resourceSourceInput.extend({
        instructions: z.array(
          z.object({
            id: z.string().min(1),
            variant: z.enum(['all', 'ori', 'thumb']),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      // Never delete from a static account. Its uin may match an account that
      // IS installed locally, in which case these paths resolve to that other
      // account's files — deleting them would destroy data the user never
      // pointed us at. The service's containment check can't catch this: the
      // paths are perfectly valid, just not ours to touch.
      if (getAppContext().accountIsStatic) {
        throw new Error('静态账号不提供本地资源清理：这些资源不属于导入的数据库快照。');
      }
      const services = requireResourceSource(input);
      const result = await services.resourceCleanup.cleanup(input.instructions);
      assertResourceSource(services, input);
      return result;
    }),
});

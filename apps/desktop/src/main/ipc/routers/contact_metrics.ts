import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import { procedure, router } from '../trpc';
import type { ContactDirectoryRuntime } from '../../context/contact_metrics';

const binding = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
});
export function createContactMetricsRouter(
  resolve: (input: z.infer<typeof binding>) => ContactDirectoryRuntime,
) {
  return router({
    status: procedure.input(binding).query(({ input }) => resolve(input).status()),
    snapshot: procedure.input(binding).query(({ input }) => resolve(input).snapshot()),
    rebuild: procedure
      .input(
        binding.extend({
          missingOnly: z.boolean().default(false),
          range: z.enum(['all', 'older24h']).default('all'),
          target: z.enum(['metrics', 'groupMembers']).default('metrics'),
          fields: z
            .array(
              z.enum([
                'level',
                'likeCount',
                'addedAt',
                'direction',
                'commonFriends',
                'commonGroups',
                'friendCount',
                'activityScore',
              ]),
            )
            .optional(),
        }),
      )
      .mutation(({ input }) =>
        resolve(input).rebuild(input.missingOnly, input.fields, input.range, input.target),
      ),
    changed: procedure.input(binding).subscription(({ input }) => {
      const runtime = resolve(input);
      return observable<{ base: boolean; relationGraph?: boolean }>((emit) => {
        const change = () => emit.next({ base: false });
        const base = () => emit.next({ base: true });
        const graph = () => emit.next({ base: false, relationGraph: true });
        runtime.cache.on('changed', change);
        runtime.cache.on('baseChanged', base);
        runtime.cache.on('relationGraphChanged', graph);
        return () => {
          runtime.cache.off('changed', change);
          runtime.cache.off('baseChanged', base);
          runtime.cache.off('relationGraphChanged', graph);
        };
      });
    }),
  });
}

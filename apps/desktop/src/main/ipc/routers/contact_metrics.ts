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
    localTimes: procedure
      .input(binding.extend({ kind: z.enum(['friends', 'groups']) }))
      .query(({ input }) => resolve(input).localTimes(input.kind)),
    cachedProfiles: procedure.input(binding).query(({ input }) => resolve(input).cachedProfiles()),
    localJoins: procedure.input(binding).query(({ input }) => resolve(input).localJoins()),
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
                'energy',
                'source',
                'sourceGroup',
                'schools',
                'joinedAt',
                'grade',
                'freezeState',
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
      return observable<{ base: boolean; relationGraph?: boolean; profiles?: boolean }>((emit) => {
        const change = () => emit.next({ base: false });
        const base = () => emit.next({ base: true });
        const graph = () => emit.next({ base: false, relationGraph: true });
        const profiles = () => emit.next({ base: false, profiles: true });
        runtime.cache.on('changed', change);
        runtime.cache.on('baseChanged', base);
        runtime.cache.on('relationGraphChanged', graph);
        runtime.cache.on('profilesChanged', profiles);
        return () => {
          runtime.cache.off('changed', change);
          runtime.cache.off('baseChanged', base);
          runtime.cache.off('relationGraphChanged', graph);
          runtime.cache.off('profilesChanged', profiles);
        };
      });
    }),
  });
}

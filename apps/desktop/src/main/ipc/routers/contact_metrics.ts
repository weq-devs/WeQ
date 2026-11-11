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
    history: router({
      categories: procedure
        .input(binding.extend({ entity: z.string().regex(/^(friend|group|account):[\w-]+$/) }))
        .query(({ input }) => resolve(input).history.categories(input.entity)),
      status: procedure.input(binding).query(({ input }) => resolve(input).history.status()),
      list: procedure
        .input(
          binding.extend({
            entity: z.string().regex(/^(friend|group|account):[\w-]+$/),
            category: z.string().max(128).default(''),
            before: z.number().int().positive().safe().optional(),
            limit: z.number().int().min(1).max(100).default(30),
          }),
        )
        .query(({ input }) =>
          resolve(input).history.list(input.entity, input.category, input.before, input.limit),
        ),
      version: procedure
        .input(
          binding.extend({
            entity: z.string().regex(/^(friend|group|account):[\w-]+$/),
            id: z.number().int().positive().safe(),
          }),
        )
        .query(({ input }) => resolve(input).history.version(input.entity, input.id)),
      diff: procedure
        .input(
          binding.extend({
            entity: z.string().regex(/^(friend|group|account):[\w-]+$/),
            id: z.number().int().positive().safe(),
          }),
        )
        .query(({ input }) => resolve(input).history.diff(input.entity, input.id)),
    }),
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

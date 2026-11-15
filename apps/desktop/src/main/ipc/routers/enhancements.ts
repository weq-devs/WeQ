import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import type { EnhancementUpdateNotice } from '../../../shared/enhancement_release';
import { ENHANCEMENT_PACK_IDS } from '../../../shared/enhancement_manifest';
import { requireBootstrap } from '../../context/app_context';
import { startEnhancementDownloads } from '../../enhancements/tasks';
import { procedure } from '../trpc';

const packId = z.enum(ENHANCEMENT_PACK_IDS);
const selection = z.object({ ids: z.array(packId).min(1).max(ENHANCEMENT_PACK_IDS.length) });

export const enhancementProcedures = {
  onEnhancementUpdates: procedure.subscription(() =>
    observable<EnhancementUpdateNotice[]>((emit) =>
      requireBootstrap().enhancements.updates.subscribeNotifications((notices) =>
        emit.next(notices),
      ),
    ),
  ),
  acknowledgeEnhancementUpdates: procedure
    .input(
      z
        .array(z.object({ id: packId, contentVersion: z.string().regex(/^[a-f0-9]{64}$/) }))
        .max(ENHANCEMENT_PACK_IDS.length),
    )
    .mutation(async ({ input }) => {
      await requireBootstrap().enhancements.updates.acknowledgeNotifications(input);
      return true;
    }),
  enhancementPacks: procedure.query(async () => {
    const resources = requireBootstrap().enhancements;
    await resources.inspected;
    await resources.updates.ready();
    const packs = await resources.packs.list();
    return {
      packs: packs.map((pack) => ({ ...pack, check: resources.updates.state(pack.id) })),
      preferences: requireBootstrap().userConfig.getSettings().enhancementUpdates,
      all: resources.packs.plan(
        packs.filter((pack) => !pack.downloaded && !pack.blocker).map((pack) => pack.id),
      ),
    };
  }),
  setEnhancementUpdates: procedure
    .input(
      z.object({ autoCheck: z.boolean().optional(), autoInstall: z.boolean().optional() }).strict(),
    )
    .mutation(
      ({ input }) =>
        requireBootstrap().userConfig.setSettings({ enhancementUpdates: input }).enhancementUpdates,
    ),
  checkEnhancementUpdates: procedure.input(selection).mutation(async ({ input }) => {
    await requireBootstrap().enhancements.updates.check(input.ids);
    return true;
  }),
  enhancementPlan: procedure
    .input(selection)
    .query(({ input }) => requireBootstrap().enhancements.packs.plan(input.ids)),
  prepareEnhancementPacks: procedure.input(selection).mutation(async ({ input }) => {
    const packs = requireBootstrap().enhancements.packs;
    await startEnhancementDownloads(packs, input.ids);
    return true;
  }),
  deleteEnhancementPack: procedure.input(z.object({ id: packId })).mutation(async ({ input }) => {
    await requireBootstrap().enhancements.packs.remove(input.id);
    return true;
  }),
  pauseEnhancementPack: procedure.input(z.object({ id: packId })).mutation(({ input }) => {
    requireBootstrap().enhancements.packs.pause(input.id);
    return true;
  }),
  resumeEnhancementPack: procedure.input(z.object({ id: packId })).mutation(({ input }) => {
    requireBootstrap().enhancements.packs.resume(input.id);
    return true;
  }),
};

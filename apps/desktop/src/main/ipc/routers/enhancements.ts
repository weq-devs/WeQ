import { z } from 'zod';
import { ENHANCEMENT_PACK_IDS } from '../../../shared/enhancement_manifest';
import { requireBootstrap } from '../../context/app_context';
import { startEnhancementDownloads } from '../../enhancements/tasks';
import { procedure } from '../trpc';

const packId = z.enum(ENHANCEMENT_PACK_IDS);
const selection = z.object({ ids: z.array(packId).min(1).max(ENHANCEMENT_PACK_IDS.length) });

export const enhancementProcedures = {
  enhancementPacks: procedure.query(async () => {
    const resources = requireBootstrap().enhancements;
    await resources.inspected;
    await resources.packs.reconcileExisting();
    const packs = await resources.packs.list();
    return {
      packs,
      all: resources.packs.plan(
        packs.filter((pack) => !pack.downloaded && !pack.blocker).map((pack) => pack.id),
      ),
    };
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

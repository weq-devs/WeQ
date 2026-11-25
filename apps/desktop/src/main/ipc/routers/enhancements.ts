import { z } from 'zod/v3';
import { observable } from '@trpc/server/observable';
import type { EnhancementUpdateNotice } from '../../../shared/enhancement_release';
import { ENHANCEMENT_PACK_IDS } from '../../../shared/enhancement_manifest';
import { requireBootstrap } from '../../context/app_context';
import type { EnhancementStateChange } from '../../enhancements/updates';
import {
  backgroundEnhancementDownload,
  enhancementDownloadTask,
  forgetRemovedPackTask,
  startEnhancementDownloads,
} from '../../enhancements/tasks';
import { procedure } from '../trpc';

const packId = z.enum(ENHANCEMENT_PACK_IDS);
const selection = z.object({ ids: z.array(packId).min(1).max(ENHANCEMENT_PACK_IDS.length) });

export const enhancementProcedures = {
  onEnhancementStateChanged: procedure.subscription(() =>
    observable<EnhancementStateChange>((emit) =>
      requireBootstrap().enhancements.updates.subscribeState((change) => emit.next(change)),
    ),
  ),
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
    const { enhancements: resources, userConfig } = requireBootstrap();
    await resources.inspected;
    await resources.updates.ready();
    const packs = await resources.packs.list();
    const preferences = userConfig.getSettings().enhancementUpdates;
    return {
      packs: packs.map((pack) => {
        const autoUpdate = preferences.autoUpdatePacks.includes(pack.id);
        const downloadTask = enhancementDownloadTask(resources.packs, pack.id);
        return {
          ...pack,
          autoUpdate,
          updateNeedsAttention:
            pack.updateAvailable &&
            (!autoUpdate ||
              !preferences.autoCheck ||
              !!pack.blocker ||
              pack.operation?.phase === 'failed' ||
              downloadTask?.status === 'failed'),
          check: resources.updates.state(pack.id),
          downloadTask,
        };
      }),
      preferences: { autoCheck: preferences.autoCheck },
      all: resources.packs.plan(
        packs.filter((pack) => !pack.downloaded && !pack.blocker).map((pack) => pack.id),
      ),
    };
  }),
  setEnhancementUpdates: procedure
    .input(
      z
        .object({
          autoCheck: z.boolean().optional(),
          pack: z.object({ id: packId, enabled: z.boolean() }).optional(),
        })
        .strict(),
    )
    .mutation(async ({ input: { autoCheck, pack } }) => {
      const { enhancements: resources, userConfig } = requireBootstrap();
      await resources.updates.ready();
      const current = userConfig.getSettings().enhancementUpdates;
      const enabled = new Set(current.autoUpdatePacks);
      if (pack?.enabled) enabled.add(pack.id);
      else if (pack) enabled.delete(pack.id);
      return userConfig.setSettings({
        enhancementUpdates: {
          autoCheck: autoCheck ?? current.autoCheck,
          autoUpdatePacks: ENHANCEMENT_PACK_IDS.filter((id) => enabled.has(id)),
        },
      }).enhancementUpdates;
    }),
  checkEnhancementUpdates: procedure.input(selection).mutation(async ({ input }) => {
    await requireBootstrap().enhancements.updates.check(input.ids);
    return true;
  }),
  enhancementPlan: procedure
    .input(selection)
    .query(({ input }) => requireBootstrap().enhancements.packs.plan(input.ids)),
  prepareEnhancementPacks: procedure
    .input(
      selection.extend({
        foreground: z.boolean().optional(),
        mode: z.enum(['download', 'update']).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const packs = requireBootstrap().enhancements.packs;
      await startEnhancementDownloads(packs, input.ids, input);
      return true;
    }),
  backgroundEnhancementPack: procedure
    .input(z.object({ id: packId, taskId: z.string().uuid() }))
    .mutation(({ input }) => {
      backgroundEnhancementDownload(requireBootstrap().enhancements.packs, input.id, input.taskId);
      return true;
    }),
  deleteEnhancementPack: procedure.input(z.object({ id: packId })).mutation(async ({ input }) => {
    const packs = requireBootstrap().enhancements.packs;
    await packs.remove(input.id);
    await forgetRemovedPackTask(packs, input.id);
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

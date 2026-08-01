/**
 * `account.sysEmoji.*` — browse the open account's built-in system-emoji
 * resource set (`nt_data/Emoji/BaseEmojiSyastems/EmojiSystermResource/*`). Thin
 * tRPC skin over `SysEmojiResourceService` (see `@weq/service`). The image /
 * animation bytes are NOT returned here — the renderer streams each format via
 * the existing `weq-asset://emoji/<name>/<fmt>/<file>` protocol.
 *
 * `downloadStatus` / `downloadAll` cover the case where QQ's own resource
 * directory is missing: faces are then fetched from the official CDN into a
 * mirror cache (`SysEmojiDownloadService`). Rendering already backfills faces
 * one at a time on demand; this is the explicit "grab everything now" path.
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

export const sysEmojiRouter = router({
  /** One page of system-emoji faces (which of png/apng/lottie each carries). */
  listEntries: procedure
    .input(
      z.object({
        limit: z.number().int().positive().optional(),
        cursor: z.string().nullish(),
      }),
    )
    .query(({ input }) => {
      return requireServices().sysEmoji.listEntries({
        limit: input.limit,
        cursor: input.cursor ?? null,
      });
    }),

  /** Whether QQ's own face directory exists, and how many faces are on disk. */
  downloadStatus: procedure.query(() => requireServices().sysEmojiDownload.status()),

  /** Fetch every downloadable face from the CDN into the mirror cache. */
  downloadAll: procedure.mutation(async () => {
    const services = requireServices();
    const result = await services.sysEmojiDownload.ensureAll();
    // The browser caches its directory listing; new faces won't show otherwise.
    services.sysEmoji.invalidate();
    return result;
  }),
});

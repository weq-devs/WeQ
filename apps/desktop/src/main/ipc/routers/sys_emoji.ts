/**
 * `account.sysEmoji.*` — browse the open account's built-in system-emoji
 * resource set (`nt_data/Emoji/BaseEmojiSyastems/EmojiSystermResource/*`). Thin
 * tRPC skin over `SysEmojiResourceService` (see `@weq/service`). The image /
 * animation bytes are NOT returned here — the renderer streams each format via
 * the existing `weq-asset://emoji/<name>/<fmt>/<file>` protocol. Read-only.
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
});

/**
 * `account.marketEmoji.*` — browse the open account's market-face (store
 * sticker) cache (`nt_data/Emoji/marketface/*`). Thin tRPC skin over
 * `MarketEmojiResourceService` (see `@weq/service`). The image bytes are NOT
 * returned here — the renderer streams each file via the existing
 * `weq-media://mface?pack=<itemId>&hash=<hash>` protocol. Read-only.
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

export const marketEmojiRouter = router({
  /** One page of market-face stickers (itemId + hash + detected MIME type). */
  listEntries: procedure
    .input(
      z.object({
        limit: z.number().int().positive().optional(),
        cursor: z.string().nullish(),
      }),
    )
    .query(({ input }) => {
      return requireServices().marketEmoji.listEntries({
        limit: input.limit,
        cursor: input.cursor ?? null,
      });
    }),
});

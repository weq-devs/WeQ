/**
 * `account.relatedEmoji.*` — browse the open account's related-emoji cache
 * (`nt_data/Emoji/emoji-related/emoji`): keywords whose `md5(keyword)` dir holds
 * plaintext gifs. Thin tRPC skin over `RelatedEmojiResourceService`. Image bytes
 * are NOT returned here — the renderer streams each gif via the
 * `weq-media://relemoji?hash=<md5>&file=<gif>` protocol. Read-only.
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

export const relatedEmojiRouter = router({
  /** One page of keywords (each with a cover gif + gif count). */
  listKeywords: procedure
    .input(
      z.object({
        limit: z.number().int().positive().optional(),
        cursor: z.string().nullish(),
      }),
    )
    .query(({ input }) => {
      return requireServices().relatedEmoji.listKeywords({
        limit: input.limit,
        cursor: input.cursor ?? null,
      });
    }),

  /** All gif file names in one keyword's hash dir (for the lightbox). */
  listGifs: procedure
    .input(z.object({ hash: z.string() }))
    .query(({ input }) => {
      return requireServices().relatedEmoji.listGifs(input.hash);
    }),
});

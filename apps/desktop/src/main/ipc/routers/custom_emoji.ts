/**
 * `account.customEmoji.*` — browse the open account's custom-emoji cache:
 * received emoji (`nt_data/Emoji/emoji-recv/<month>`) and the user's own /
 * favourited emoji (`nt_data/Emoji/personal_emoji`). Thin tRPC skin over
 * `CustomEmojiResourceService` (see `@weq/service`). The image bytes are NOT
 * returned here — the renderer streams each file via the
 * `weq-media://cemoji?scope=<scope>&bucket=<month>&hash=<hash>&v=ori|thumb`
 * protocol. Read-only.
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

const scopeEnum = z.enum(['recv', 'personal']);

export const customEmojiRouter = router({
  /** Presence + merged entry counts for the two custom-emoji scopes. */
  listScopes: procedure.query(() => {
    return requireServices().customEmoji.listScopes();
  }),

  /** One page of merged custom-emoji entries (ori + thumb) for a scope. */
  listEntries: procedure
    .input(
      z.object({
        scope: scopeEnum,
        limit: z.number().int().positive().optional(),
        cursor: z.string().nullish(),
      }),
    )
    .query(({ input }) => {
      return requireServices().customEmoji.listEntries(input.scope, {
        limit: input.limit,
        cursor: input.cursor ?? null,
      });
    }),
});

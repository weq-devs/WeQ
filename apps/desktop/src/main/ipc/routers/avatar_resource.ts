/**
 * `account.avatarResource.*` — browse the open account's local avatar cache
 * (`nt_data/avatar/{user,group,cover}`). Thin tRPC skin over
 * `AvatarResourceService` (see `@weq/service`); all the scanning / merging lives
 * there. The image bytes are NOT returned here — the renderer points `<img>` at
 * the `weq-media://avatar` protocol, which resolves the file via the same
 * service. Read-only; a cleanup surface will come later.
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

const scope = z.enum(['user', 'group', 'cover']);

export const avatarResourceRouter = router({
  /** Per-scope presence + merged entry counts (drives the sub-tab row). */
  listScopes: procedure.query(() => {
    return requireServices().avatarResource.listScopes();
  }),

  /** One page of merged avatar entries (big + small merged by hash). */
  listEntries: procedure
    .input(
      z.object({
        scope,
        limit: z.number().int().positive().optional(),
        cursor: z.string().nullish(),
      }),
    )
    .query(({ input }) => {
      return requireServices().avatarResource.listEntries(input.scope, {
        limit: input.limit,
        cursor: input.cursor ?? null,
      });
    }),

  /**
   * Given a QQ number, derive where its avatar is cached (the 头像路径 tool).
   * `kind=user` translates uin→uid via profile_info_v6; `kind=group` uses the
   * number directly (group uin == uid). Returns the uid, computed hash and each
   * variant's on-disk presence.
   */
  computePath: procedure
    .input(z.object({ kind: z.enum(['user', 'group']), qq: z.string().trim() }))
    .query(({ input }) => {
      return requireServices().avatarResource.probeByQq(input.kind, input.qq);
    }),
});

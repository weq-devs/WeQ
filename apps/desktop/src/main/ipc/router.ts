/**
 * Top-level router. `AppRouter` type is the contract the renderer uses
 * to derive end-to-end-typed tRPC clients.
 *
 * The two sub-routers split by lifecycle, NOT by URL aesthetics:
 *   - `bootstrap` — usable any time (read-only platform probes, dbkey
 *      acquisition, account open/close)
 *   - `account`   — requires a live AccountSession (msg / peer queries)
 */

import { router } from './trpc';
import { bootstrapRouter } from './routers/bootstrap';
import { accountRouter } from './routers/account';
import { updateRouter } from './routers/update';

export const appRouter = router({
  bootstrap: bootstrapRouter,
  account: accountRouter,
  update: updateRouter,
});

export type AppRouter = typeof appRouter;

/**
 * Top-level router. `AppRouter` type is the contract the renderer uses
 * to derive end-to-end-typed tRPC clients.
 *
 * The three sub-routers split by lifecycle, NOT by URL aesthetics:
 *   - `bootstrap` — usable any time (read-only platform probes, dbkey
 *      acquisition, account open/close)
 *   - `account`   — requires a live AccountSession (msg / peer queries)
 *   - `update`    — in-app updates; the shell installs the implementation
 *      (`UpdateActions`), so this module stays Electron-free and the web app
 *      can mount the very same router.
 */

import { router } from './trpc';
import { bootstrapRouter } from './routers/bootstrap';
import { accountRouter } from './routers/account';
import { updateRouter } from './routers/update';
import { helpRouter } from './routers/help';

export const appRouter = router({
  bootstrap: bootstrapRouter,
  account: accountRouter,
  update: updateRouter,
  help: helpRouter,
});

export type AppRouter = typeof appRouter;

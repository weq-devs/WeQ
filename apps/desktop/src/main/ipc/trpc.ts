/**
 * tRPC server setup for the Electron main process.
 *
 * Uses superjson transformer to handle bigint, Date, and other non-JSON types.
 * electron-trpc 0.7 + tRPC v11 requires an explicit transformer on both sides.
 */

import { initTRPC } from '@trpc/server';
import superjson from 'superjson';

export interface RpcContext {
  authorize?: () => void;
}

const t = initTRPC.context<RpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const procedure = t.procedure.use(({ ctx, next }) => {
  ctx.authorize?.();
  return next();
});

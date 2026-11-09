/**
 * tRPC server setup for the Electron main process.
 *
 * Uses superjson transformer to handle bigint, Date, and other non-JSON types.
 * electron-trpc 0.7 + tRPC v11 requires an explicit transformer on both sides.
 */

import { initTRPC } from '@trpc/server';
import superjson from 'superjson';
import { withHost, logRequest, type HostBridge } from '@weq/service';
import { maintenanceProcedures, runtimeMaintenance } from '../runtime_maintenance';
import { pickedBrowserFiles } from '../browser_files';

export interface RpcContext {
  authorize?: () => void;
  host?: HostBridge;
}

const t = initTRPC.context<RpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const procedure = t.procedure.use(({ ctx, next, path, type, rawInput }) =>
  logRequest(
    'trpc',
    path,
    type,
    async () => {
      ctx.authorize?.();
      const invoke = () => (ctx.host ? withHost(ctx.host, () => next()) : next());
      const run = () =>
        type === 'subscription' ? invoke() : pickedBrowserFiles.withPaths(rawInput, invoke);
      return type === 'subscription' || maintenanceProcedures.has(path.split('.').at(-1) ?? path)
        ? run()
        : runtimeMaintenance.operation(run);
    },
    (result) => (result.ok ? undefined : result.error),
  ),
);

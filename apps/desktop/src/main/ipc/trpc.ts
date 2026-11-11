/**
 * tRPC server setup for the Electron main process.
 *
 * Uses superjson transformer to handle bigint, Date, and other non-JSON types.
 * electron-trpc 0.7 + tRPC v11 requires an explicit transformer on both sides.
 */

import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { withHost, logRequest, type HostBridge } from '@weq/service';
import { maintenanceProcedures, runtimeMaintenance } from '../runtime_maintenance';
import { pickedBrowserFiles } from '../browser_files';
import {
  REMOTE_UNSUPPORTED_MESSAGE,
  remoteProcedureUnavailable,
} from '../../shared/remote_capabilities';

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
      if (ctx.host?.remoteClient && remoteProcedureUnavailable(path, rawInput))
        throw new TRPCError({ code: 'FORBIDDEN', message: REMOTE_UNSUPPORTED_MESSAGE });
      const invoke = () => (ctx.host ? withHost(ctx.host, () => next()) : next());
      const run = () =>
        type === 'subscription' ? invoke() : pickedBrowserFiles.withPaths(rawInput, invoke);
      return type === 'subscription' ||
        maintenanceProcedures.has(path) ||
        maintenanceProcedures.has(path.split('.').at(-1) ?? path)
        ? run()
        : runtimeMaintenance.operation(run, path);
    },
    (result) => (result.ok ? undefined : result.error),
  ),
);

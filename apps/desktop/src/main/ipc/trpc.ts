/**
 * tRPC server setup for the Electron main process.
 *
 * Uses superjson transformer to handle bigint, Date, and other non-JSON types.
 * electron-trpc 0.7 + tRPC v11 requires an explicit transformer on both sides.
 */

import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { networkScope } from '@weq/service/network-scope';
import { transferRestricted } from '@weq/service/transfer-policy';
import { withHost, logRequest, type HostBridge } from '@weq/service';
import { maintenanceProcedures, runtimeMaintenance } from '../runtime_maintenance';
import { pickedBrowserFiles } from '../browser_files';
import {
  REMOTE_UNSUPPORTED_MESSAGE,
  remoteProcedureUnavailable,
} from '../../shared/remote_capabilities';

export interface RpcContext {
  networkClientId?: string;
  authorize?: () => void;
  host?: HostBridge;
}

const t = initTRPC.context<RpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
const accountWindowOnly = new Set([
  'bootstrap.openAccount',
  'bootstrap.openStaticAccount',
  'bootstrap.closeAccount',
  'bootstrap.deleteAccountConfig',
  'bootstrap.desktopStartup',
  'bootstrap.setAutoEnter',
  'bootstrap.clearAutoEnter',
  'bootstrap.applyBackupLive',
]);
const hostAccountAdmin =
  /^(?:remote\.|wonderfulTools\.|dbRepair\.|bootstrap\.(?:readConfig|listAccounts|listAccountConfigs|resolveQqPid|probeOnline|dbFileSizes|ntDataSizes|accountDirSizeProgress|testDatabaseKey|verifyAccountKey|fetchAccount|quickLogin|qrLogin|rebuildAccount|backup(?:Export|Inventory|Pick|BeginUpload|UploadChunk|FinishUpload|Prepare|Stage|Defaults|Apply|Cancel)|getMcp|setMcp|regenerateMcp|listMcpAgentTargets|installMcpToAgents))/;
export const procedure = t.procedure.use(({ ctx, next, path, type, rawInput }) =>
  logRequest(
    'trpc',
    path,
    type,
    async () => {
      ctx.authorize?.();
      if (ctx.host?.accountScoped && accountWindowOnly.has(path))
        throw new TRPCError({ code: 'FORBIDDEN', message: '请通过账号选择页切换或关闭网页会话。' });
      if (ctx.host?.accountScoped && ctx.host.remoteClient && hostAccountAdmin.test(path))
        throw new TRPCError({ code: 'FORBIDDEN', message: '此功能由 WeQ 桌面管理。' });
      if (ctx.host?.remoteClient && remoteProcedureUnavailable(path, rawInput))
        throw new TRPCError({ code: 'FORBIDDEN', message: REMOTE_UNSUPPORTED_MESSAGE });
      const invoke = () =>
        networkScope.run(
          {
            clientId: ctx.networkClientId,
            restricted: transferRestricted(ctx.networkClientId),
            intent: type === 'mutation' ? 'interactive' : 'prefetch',
          },
          () => (ctx.host ? withHost(ctx.host, () => next()) : next()),
        );
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

import { z } from 'zod';
import { basename } from 'node:path';
import {
  getHost,
  WEQ_BACKUP_PARTS,
  WEQ_BACKUP_LIMITS,
  readWeqBackupFile,
  writeWeqBackupExclusive,
  weqBackupRestoreStatus,
  cancelWeqBackupRestore,
  pendingWeqClientSettings,
  acknowledgeWeqClientSettings,
  skipWeqClientSettings,
  reassignWeqClientSettings,
} from '@weq/service';
import { getBackupContext } from '../../context/backup_context';
import { retryBackupRecovery } from '../../context/app_context';
import { procedure } from '../trpc';

const selection = z.object({
  parts: z.array(z.enum(WEQ_BACKUP_PARTS)).min(1).max(4),
  accountConfigIds: z.array(z.string()).optional(),
  cloneConfigIds: z.array(z.string()).optional(),
  includeClient: z.boolean().optional(),
});
const choice = selection.extend({
  conflict: z.enum(['overwrite', 'skip']),
  scopeMap: z.record(z.string()).optional(),
  keepLocalPaths: z.boolean().optional(),
  clientId: z.string().uuid().optional(),
});
function ready() {
  const ctx = getBackupContext();
  if (!ctx.ok) throw new Error(ctx.error);
  return ctx;
}

export const backupProcedures = {
  backupStartup: procedure
    .input(z.object({ clientId: z.string().uuid().optional() }).optional())
    .query(({ input }) => {
      const ctx = getBackupContext();
      const stored = ctx.ok ? weqBackupRestoreStatus(ctx.root).result : ctx.result;
      const result =
        ctx.result && stored?.id !== ctx.result.id ? ctx.result : (stored ?? ctx.result);
      return {
        ok: ctx.ok,
        error: ctx.error,
        result,
        appliedThisStartup: Boolean(ctx.result),
        client: ctx.ok ? pendingWeqClientSettings(ctx.root, input?.clientId) : null,
        canReveal: getHost().canReveal,
        canRestart: Boolean(getHost().restartApplication),
        toastDurations: ctx.ok ? ctx.config.getSettings().toastDurations : undefined,
      };
    }),
  backupInventory: procedure.query(() => ({
    ...ready().backups.inventory(),
    canPickFile: getHost().canReveal,
    canRestart: Boolean(getHost().restartApplication),
    maxArchiveBytes: WEQ_BACKUP_LIMITS.maxArchiveBytes,
    chunkBytes: 65536,
  })),
  backupExport: procedure
    .input(selection.extend({ client: z.record(z.string()).default({}) }))
    .mutation(async ({ input }) => {
      const ctx = ready(),
        host = getHost();
      const timestamp = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
        .format(new Date())
        .replace(/[^0-9]/g, '');
      const target = await host.pickSaveTarget({
        locationKey: 'weq-backup',
        defaultName: `weq-backup-${timestamp}.zip`,
        extension: 'zip',
      });
      if (!target) return null;
      const snapshot = ctx.backups.snapshot(input, input.client);
      await writeWeqBackupExclusive(target.path, snapshot.archive);
      const download = host.registerDownload?.(target.path, basename(target.path), 'file');
      return {
        id: ctx.backups.rememberExport(target.path),
        path: target.path,
        downloadUrl: download?.url ?? null,
        canReveal: host.canReveal,
        summary: snapshot.summary,
      };
    }),
  backupPick: procedure.mutation(async () => {
    const ctx = ready();
    const path = await getHost().pickFile({ title: '选择 WeQ 备份', extensions: ['zip'] });
    return path
      ? ctx.backups.inspect(
          readWeqBackupFile(path, WEQ_BACKUP_LIMITS.maxArchiveBytes),
          basename(path),
        )
      : null;
  }),
  backupBeginUpload: procedure
    .input(
      z.object({
        name: z.string().min(1).max(512),
        bytes: z.number().int().min(1).max(WEQ_BACKUP_LIMITS.maxArchiveBytes),
      }),
    )
    .mutation(({ input }) => ready().backups.beginUpload(input.name, input.bytes)),
  backupUploadChunk: procedure
    .input(
      z.object({ id: z.string(), offset: z.number().int().min(0), data: z.string().max(87384) }),
    )
    .mutation(({ input }) => ready().backups.uploadChunk(input.id, input.offset, input.data)),
  backupFinishUpload: procedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => ready().backups.finishUpload(input.id)),
  backupPrepare: procedure
    .input(choice.extend({ sourceId: z.string() }))
    .mutation(({ input: { sourceId, ...choice } }) => ready().backups.prepare(sourceId, choice)),
  backupStage: procedure
    .input(z.object({ previewId: z.string() }))
    .mutation(({ input }) => ready().backups.stage(input.previewId)),
  backupDefaults: procedure
    .input(z.object({ clientId: z.string().uuid().optional() }).optional())
    .mutation(({ input }) => ready().backups.stageDefaults(input?.clientId)),
  backupDiscardPreview: procedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    const ctx = getBackupContext();
    if (ctx.ok) ctx.backups.dispose(input.id);
    return true;
  }),
  backupCancel: procedure.mutation(() => {
    const ctx = getBackupContext();
    cancelWeqBackupRestore(ctx.root, ctx.cacheRoot);
    return true;
  }),
  backupStatus: procedure.query(() => weqBackupRestoreStatus(getBackupContext().root)),
  backupAcknowledgeClient: procedure
    .input(z.object({ id: z.string(), clientId: z.string().uuid().optional() }))
    .mutation(({ input }) =>
      acknowledgeWeqClientSettings(getBackupContext().root, input.id, input.clientId),
    ),
  backupClaimClient: procedure
    .input(z.object({ id: z.string(), clientId: z.string().uuid() }))
    .mutation(({ input }) =>
      reassignWeqClientSettings(getBackupContext().root, input.id, input.clientId),
    ),
  backupSkipClient: procedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => skipWeqClientSettings(getBackupContext().root, input.id)),
  backupRetryRecovery: procedure.mutation(() => retryBackupRecovery()),
  backupOpenDirectory: procedure.mutation(() => getHost().revealPath(getBackupContext().root)),
  backupRevealExport: procedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => getHost().revealInFolder(ready().backups.exportPath(input.id))),
  backupRestart: procedure.mutation(async () => {
    const restart = getHost().restartApplication;
    if (!restart) throw new Error('请通过服务管理器重启当前服务');
    await restart();
    return true;
  }),
};

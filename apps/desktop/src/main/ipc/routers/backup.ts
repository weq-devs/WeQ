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
  DEFAULT_APP_SETTINGS,
  WEQ_DEFAULTS_PATHS,
  WEQ_DEFAULTS_CONNECTIONS,
  type WeqDefaultsConnection,
  recordWeqRestoreWarnings,
} from '@weq/service';
import { getBackupContext } from '../../context/backup_context';
import { retryBackupRecovery } from '../../context/app_context';
import { procedure } from '../trpc';
import { backgroundTasks, runBackgroundTask } from '../../background_tasks';
import { observable } from '@trpc/server/observable';
import { runtimeMaintenance } from '../../runtime_maintenance';
import { applyBackupLive } from '../../context/runtime_files';
import { desktopWebRuntime } from '../../web/runtime';
import { remoteRuntime } from '../../remote/runtime';

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
  onRuntimeFilesChanged: procedure.subscription(() =>
    observable<ReturnType<typeof runtimeMaintenance.status>>((emit) => {
      const handler = (state: ReturnType<typeof runtimeMaintenance.status>) => emit.next(state);
      runtimeMaintenance.events.on('changed', handler);
      handler(runtimeMaintenance.status());
      return () => {
        runtimeMaintenance.events.off('changed', handler);
      };
    }),
  ),
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
      return runBackgroundTask(
        { kind: 'backup', name: 'WeQ 配置备份' },
        async (id) => {
          const snapshot = ctx.backups.snapshot(input, input.client);
          await writeWeqBackupExclusive(target.path, snapshot.archive);
          const download = host.registerDownload?.(target.path, basename(target.path), 'file');
          if (download)
            backgroundTasks.update(id, {
              download: { url: download.url, name: basename(target.path) },
            });
          if (host.canReveal)
            backgroundTasks.setActions(id, [
              { id: 'open', label: '定位备份文件', run: () => host.revealInFolder(target.path) },
            ]);
          return {
            id: ctx.backups.rememberExport(target.path),
            path: target.path,
            downloadUrl: download?.url ?? null,
            canReveal: host.canReveal,
            summary: snapshot.summary,
          };
        },
        (result) => ({ note: result.path }),
      );
    }),
  backupPick: procedure.mutation(async () => {
    const ctx = ready();
    const path = await getHost().pickFile({ title: '选择 WeQ 备份', extensions: ['zip'] });
    return path
      ? runBackgroundTask(
          { kind: 'backup', name: '读取 WeQ 备份' },
          () =>
            ctx.backups.inspect(
              readWeqBackupFile(path, WEQ_BACKUP_LIMITS.maxArchiveBytes),
              basename(path),
            ),
          () => ({ note: '备份已读取，尚未执行恢复' }),
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
    .mutation(({ input: { sourceId, ...choice } }) =>
      runBackgroundTask(
        { kind: 'backup', name: '校验 WeQ 恢复范围' },
        () => ready().backups.prepare(sourceId, choice),
        () => ({ note: '恢复范围已校验，尚未应用恢复' }),
      ),
    ),
  backupStage: procedure.input(z.object({ previewId: z.string() })).mutation(({ input }) =>
    runBackgroundTask(
      { kind: 'backup', name: '暂存 WeQ 恢复' },
      () => applyBackupLive(() => ready().backups.stage(input.previewId)),
      () => ({ note: '备份已恢复，无需重启 WeQ' }),
    ),
  ),
  backupDefaults: procedure
    .input(
      z
        .object({
          clientId: z.string().uuid().optional(),
          clearApi: z.boolean().optional(),
          resetPaths: z.array(z.enum(WEQ_DEFAULTS_PATHS)).optional(),
          resetConnections: z.array(z.enum(WEQ_DEFAULTS_CONNECTIONS)).optional(),
        })
        .optional(),
    )
    .mutation(({ input, ctx }) => {
      const { clientId, ...defaults } = input ?? {};
      const selected = input?.resetConnections ?? [];
      if (
        ctx.authorize &&
        selected.some((id) =>
          [
            'systemAutostart',
            'webEnabled',
            'remoteEnabled',
            'remoteMode',
            'tailscaleEnabled',
          ].includes(id),
        )
      )
        throw new Error('请在桌面端恢复本机连接与自启设置');
      let stagedId: string | undefined;
      return runBackgroundTask(
        { kind: 'backup', name: '恢复默认设置' },
        () =>
          applyBackupLive(
            () => {
              stagedId = ready().backups.stageDefaults(clientId, defaults).id;
            },
            async (result) => {
              const attempt = async (label: string, run: () => unknown) => {
                try {
                  await run();
                } catch (error) {
                  result.warnings.push(
                    `${label}未完成：${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              };
              if (selected.includes('systemAutostart'))
                await attempt('恢复系统登录自启', async () => {
                  const host = getHost();
                  if (!host.setAutostart) throw new Error('当前宿主不支持系统自启');
                  const status = await host.setAutostart(false);
                  if (status.enabled || status.registered) throw new Error('系统自启仍已启用');
                });
              for (const [id, label] of [
                ['remoteEnabled', '远程服务'],
                ['remoteMode', '远程连接模式'],
                ['tailscaleEnabled', 'Tailscale 网络连接'],
              ] as const)
                if (selected.includes(id))
                  await attempt(`恢复${label}`, () => remoteRuntime.restorePreferences([id]));
              if (selected.includes('webEnabled'))
                await attempt('恢复 Web 服务开关', () => desktopWebRuntime.stop());
              await attempt('保存恢复回执', () => recordWeqRestoreWarnings(ready().root, result));
            },
            false,
          ).catch((error: unknown) => {
            const files = getBackupContext();
            if (files.ok && stagedId) {
              const status = weqBackupRestoreStatus(files.root);
              if (status.pending?.id === stagedId && !status.result?.needsRecovery) {
                try {
                  files.backups.cancel();
                } catch (cancelError) {
                  throw new Error(
                    `${error instanceof Error ? error.message : String(error)}；取消本次暂存失败，现场已保留：${String(cancelError)}`,
                    { cause: error },
                  );
                }
              }
            }
            throw error;
          }),
        () => ({ note: '默认设置已恢复，无需重启 WeQ' }),
      );
    }),
  backupDefaultsInfo: procedure.query(async ({ ctx }) => {
    const boot = ready();
    const settings = boot.config.getSettings();
    const connections: { id: WeqDefaultsConnection; label: string; value: string }[] = [];
    for (const [id, label] of [
      ['showWindowOnAutostart', '启动时显示窗口'],
      ['webServiceAutoStart', 'Web 服务自动启动'],
    ] as const)
      if (settings[id] !== DEFAULT_APP_SETTINGS[id])
        connections.push({ id, label, value: '已启用' });
    if (JSON.stringify(settings.weqAssistant) !== JSON.stringify(DEFAULT_APP_SETTINGS.weqAssistant))
      connections.push({
        id: 'weqAssistant',
        label: 'WeQ 助手服务',
        value: settings.weqAssistant.enabled ? '已启用' : `端口 ${settings.weqAssistant.port}`,
      });
    if (!ctx.authorize) {
      const host = getHost();
      const autostart = host.canAutostart ? await host.getAutostart?.() : null;
      if (autostart?.enabled || autostart?.registered)
        connections.push({ id: 'systemAutostart', label: '系统登录自启', value: '已启用' });
      if (desktopWebRuntime.status().enabled)
        connections.push({ id: 'webEnabled', label: 'Web 服务', value: '运行中' });
      const remote = remoteRuntime.preferences();
      if (remote.enabled)
        connections.push({ id: 'remoteEnabled', label: '远程服务', value: '已启用' });
      if (remote.mode !== 'lan')
        connections.push({ id: 'remoteMode', label: '远程连接模式', value: remote.mode });
      if (remote.tailscaleEnabled)
        connections.push({ id: 'tailscaleEnabled', label: 'Tailscale 网络连接', value: '已启用' });
    }
    return { ...boot.backups.defaultsInfo(), connections };
  }),
  backupApply: procedure.mutation(() => applyBackupLive()),
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

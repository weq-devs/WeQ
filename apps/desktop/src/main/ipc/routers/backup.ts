import { eventTimeFormatter } from '@weq/time';
import { z } from 'zod/v3';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import {
  getHost,
  WEQ_BACKUP_PARTS,
  WEQ_BACKUP_SECTIONS,
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
import { getAppContext, retryBackupRecovery } from '../../context/app_context';
import {
  recentBackupDownload,
  backupFileHash,
  pendingBackupGeneration,
  recordBackupDownload,
  resolveBackupDownload,
  saveBackupGeneration,
} from '../../backup_download_receipt';
import { procedure } from '../trpc';
import { observable } from '@trpc/server/observable';
import { runtimeMaintenance } from '../../runtime_maintenance';
import { readBackupHostPreferences } from '../../context/backup_host_preferences';
import { applyBackupLive } from '../../context/runtime_files';
import { FileUploadStaging, StagedUploadUnavailable } from './album_video_staging';
import {
  desktopServiceCommand,
  desktopWebStatus,
  setDesktopWebEnabled,
} from '../../desktop_services/host';
import { remoteRuntime } from '../../remote/runtime';
import { disableNativeDebugLog } from './help';
import { DEFAULT_QQ_SYNC_PORT } from '../../qq_sync/ipc';
import { qqSyncStatus, setQqSyncPort, setQqSyncProxyEnabled } from '../../qq_sync/runtime';
import {
  assertLogPruneConfirmed,
  describeLogPrune,
  planDefaultLogRetention,
  runLogRetentionSweep,
} from '../../log_retention';

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
  activateServices: z.boolean().optional(),
});
const selective = z.object({
  sections: z.array(z.enum(WEQ_BACKUP_SECTIONS)).min(1).max(WEQ_BACKUP_SECTIONS.length),
  accountConfigIds: z.array(z.string()),
  databaseConfigIds: z.array(z.string()),
  draftConfigIds: z.array(z.string()),
  cloneConfigIds: z.array(z.string()),
  includeApiKeys: z.boolean(),
  includeServiceTokens: z.boolean(),
});
const client = z.record(z.string()).default({});
const backupDownloadClient = z.object({ downloadClient: z.string().uuid().optional() });
const backupExportInput = z.union([
  backupDownloadClient.extend({ selection: selective, client }),
  selection.merge(backupDownloadClient).extend({ client }),
]);
const backupUploadClient = z.object({ uploadClient: z.string().uuid().optional() });
const backupTransfers = new Map<string, FileUploadStaging>();

const generatingBackups = new Set<string>();
async function generateBackup<T>(owner: string | undefined, run: () => Promise<T>) {
  if (!owner) return run();
  if (generatingBackups.has(owner)) throw new Error('这份备份正在生成。');
  generatingBackups.add(owner);
  try {
    return await run();
  } finally {
    generatingBackups.delete(owner);
  }
}

function backupTransfer(uploadClient: string) {
  const { root } = ready().backups;
  let staging = backupTransfers.get(root);
  if (!staging) {
    staging = new FileUploadStaging(30 * 60_000, {
      label: '备份',
      minBytes: 1,
      maxBytes: WEQ_BACKUP_LIMITS.maxArchiveBytes,
      prefix: 'weq-backup-transfer-',
      fileName: 'backup.zip',
      maxUploads: 8,
      maxTotalBytes: WEQ_BACKUP_LIMITS.maxArchiveBytes * 4,
      persistence: {
        root: () => join(root, 'cache', 'backup-transfer'),
        ownerKey: (owner) => (owner as { key: string }).key,
      },
    });
    backupTransfers.set(root, staging);
  }
  return { staging, owner: { key: backupDownloadOwner(uploadClient) } };
}

function backupDownloadOwner(client: string) {
  const { account, services } = getAppContext();
  return JSON.stringify([
    account?.context.uin,
    services?.accountConfig.getRecord()?.configId,
    client,
  ]);
}

function backupGenerationOwner(client: string) {
  return JSON.stringify([getHost().exportRoot ?? null, backupDownloadOwner(client)]);
}

async function snapshotBackup(input: z.infer<typeof backupExportInput>, native: boolean) {
  const { backups } = ready();
  return 'selection' in input
    ? backups.snapshotSelected(
        input.selection,
        input.client,
        await readBackupHostPreferences(input.selection.sections, native),
      )
    : backups.snapshot(input, input.client);
}

async function checkBackupPath(path: string, root: string | undefined) {
  if (!root) return;
  const [base, parent] = await Promise.all([realpath(root), realpath(dirname(path))]);
  const rel = relative(base, parent);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel))
    throw new Error('备份位置已变化，请重新选择。');
}

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
  backupInventory: procedure.input(backupDownloadClient.optional()).query(({ ctx, input }) => {
    const { backups } = ready();
    const host = getHost();
    const previousDownload =
      host.exportRoot && input?.downloadClient
        ? recentBackupDownload(backups.root, backupDownloadOwner(input.downloadClient))
        : undefined;
    const interrupted = input?.downloadClient
      ? pendingBackupGeneration(backups.root, backupGenerationOwner(input.downloadClient))
      : undefined;
    return {
      ...backups.inventory(),
      activeConfigId: getAppContext().services?.accountConfig.getConfigId() ?? null,
      canActivateServices: !ctx.authorize,
      canPickFile: host.canReveal,
      canRestart: Boolean(host.restartApplication),
      maxArchiveBytes: WEQ_BACKUP_LIMITS.maxArchiveBytes,
      chunkBytes: 65536,
      ...(previousDownload ? { previousDownload } : {}),
      ...(interrupted ? { interruptedExport: { name: basename(interrupted.path) } } : {}),
    };
  }),
  backupExport: procedure.input(backupExportInput).mutation(async ({ input, ctx: request }) => {
    const ctx = ready(),
      host = getHost();
    const owner = input.downloadClient ? backupDownloadOwner(input.downloadClient) : undefined;
    const generationOwner = input.downloadClient
      ? backupGenerationOwner(input.downloadClient)
      : undefined;
    return generateBackup(generationOwner, async () => {
      const timestamp = eventTimeFormatter.format(new Date()).replace(/[^0-9]/g, '');
      const target = await host.pickSaveTarget({
        locationKey: 'weq-backup',
        defaultName: `weq-backup-${timestamp}.zip`,
        extension: 'zip',
      });
      if (!target) return null;
      if (input.downloadClient && generationOwner !== backupGenerationOwner(input.downloadClient))
        throw new Error('账号或数据源已切换，请重新选择备份内容。');
      const draft = generationOwner
        ? { owner: generationOwner, path: target.path, input }
        : undefined;
      if (draft) saveBackupGeneration(ctx.backups.root, draft.owner, draft);
      const snapshot = await snapshotBackup(input, !request.authorize);
      if (input.downloadClient && generationOwner !== backupGenerationOwner(input.downloadClient))
        throw new Error('账号或数据源已切换，已停止生成备份。');
      if (draft)
        saveBackupGeneration(ctx.backups.root, draft.owner, {
          ...draft,
          hash: createHash('sha256').update(snapshot.archive).digest('hex'),
        });
      await writeWeqBackupExclusive(target.path, snapshot.archive);
      const download = host.registerDownload?.(target.path, basename(target.path), 'file');
      if (
        host.exportRoot &&
        download &&
        input.downloadClient &&
        owner === backupDownloadOwner(input.downloadClient)
      ) {
        try {
          recordBackupDownload(ctx.backups.root, owner, target.path, snapshot.archive);
        } catch (error) {
          console.warn('[配置备份] 取回回执保存失败', error);
        }
      }
      if (draft) saveBackupGeneration(ctx.backups.root, draft.owner, null);
      return {
        id: ctx.backups.rememberExport(target.path),
        path: target.path,
        downloadUrl: download?.url ?? null,
        canReveal: host.canReveal,
        summary: snapshot.summary,
      };
    });
  }),
  backupResumeExport: procedure
    .input(z.object({ downloadClient: z.string().uuid() }))
    .mutation(async ({ input, ctx: request }) => {
      const ctx = ready();
      const owner = backupGenerationOwner(input.downloadClient);
      return generateBackup(owner, async () => {
        const draft = pendingBackupGeneration(ctx.backups.root, owner);
        if (!draft) throw new Error('没有待继续生成的备份。');
        const host = getHost();
        await checkBackupPath(draft.path, host.exportRoot);
        const check = () => {
          if (owner !== backupGenerationOwner(input.downloadClient))
            throw new Error('账号或数据源已切换。');
        };
        const info = await stat(draft.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        let bytes: Buffer | undefined;
        if (info) {
          await checkBackupPath(await realpath(draft.path), host.exportRoot);
          if (!info.isFile() || !draft.hash || (await backupFileHash(draft.path)) !== draft.hash)
            throw new Error('原保存位置已有不同文件，请重新选择备份位置。');
        } else {
          const snapshot = await snapshotBackup(
            backupExportInput.parse(draft.input),
            !request.authorize,
          );
          bytes = snapshot.archive;
          check();
          saveBackupGeneration(ctx.backups.root, owner, {
            ...draft,
            hash: createHash('sha256').update(bytes).digest('hex'),
          });
          await writeWeqBackupExclusive(draft.path, bytes);
        }
        check();
        const download = host.registerDownload?.(draft.path, basename(draft.path), 'file');
        if (host.exportRoot && download)
          recordBackupDownload(
            ctx.backups.root,
            backupDownloadOwner(input.downloadClient),
            draft.path,
            bytes ?? (await readFile(draft.path)),
          );
        saveBackupGeneration(ctx.backups.root, owner, null);
        return { path: draft.path, downloadUrl: download?.url ?? null };
      });
    }),
  backupDownloadExport: procedure
    .input(z.object({ downloadClient: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const { backups } = ready();
      const host = getHost();
      if (!host.exportRoot || !host.registerDownload)
        throw new Error('请从生成备份时的浏览器重新下载。');
      const owner = backupDownloadOwner(input.downloadClient);
      const { path, name } = await resolveBackupDownload(backups.root, host.exportRoot, owner);
      if (owner !== backupDownloadOwner(input.downloadClient))
        throw new Error('账号或数据源已切换。');
      return host.registerDownload(path, name, 'file');
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
      backupUploadClient.extend({
        name: z.string().min(1).max(512),
        bytes: z.number().int().min(1).max(WEQ_BACKUP_LIMITS.maxArchiveBytes),
      }),
    )
    .mutation(async ({ input }) => {
      if (!input.uploadClient) return ready().backups.beginUpload(input.name, input.bytes);
      const { staging, owner } = backupTransfer(input.uploadClient);
      return (await staging.start(owner, input.bytes)).id;
    }),
  backupResumeUpload: procedure
    .input(z.object({ id: z.string().uuid(), uploadClient: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const { staging, owner } = backupTransfer(input.uploadClient);
      try {
        const status = await staging.resume(owner, input.id);
        if (owner.key !== backupDownloadOwner(input.uploadClient))
          throw new Error('账号或数据源已切换。');
        return status;
      } catch (error) {
        if (error instanceof StagedUploadUnavailable) return null;
        throw error;
      }
    }),
  backupDiscardUpload: procedure
    .input(z.object({ id: z.string().uuid(), uploadClient: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const { staging, owner } = backupTransfer(input.uploadClient);
      await staging.discard(owner, input.id);
      return true;
    }),
  backupUploadChunk: procedure
    .input(
      backupUploadClient.extend({
        id: z.string(),
        offset: z.number().int().min(0),
        data: z.string().max(87384),
      }),
    )
    .mutation(async ({ input }) => {
      if (!input.uploadClient)
        return ready().backups.uploadChunk(input.id, input.offset, input.data);
      const { staging, owner } = backupTransfer(input.uploadClient);
      const bytes = Buffer.from(input.data, 'base64');
      if (bytes.length > 65536 || bytes.toString('base64') !== input.data)
        throw new Error('备份上传分片无效');
      const result = await staging.append(owner, input.id, input.offset, bytes, undefined, () => {
        if (owner.key !== backupDownloadOwner(input.uploadClient!))
          throw new Error('账号或数据源已切换。');
      });
      return result.offset;
    }),
  backupFinishUpload: procedure
    .input(
      backupUploadClient.extend({ id: z.string(), name: z.string().min(1).max(512).optional() }),
    )
    .mutation(async ({ input }) => {
      const { backups } = ready();
      if (!input.uploadClient) return backups.finishUpload(input.id);
      const { staging, owner } = backupTransfer(input.uploadClient);
      const path = staging.acquire(owner, input.id);
      try {
        const bytes = await readFile(path);
        if (owner.key !== backupDownloadOwner(input.uploadClient))
          throw new Error('账号或数据源已切换。');
        return backups.inspect(bytes, input.name ?? 'backup.zip');
      } finally {
        await staging.discard(owner, input.id, true);
      }
    }),
  backupPrepare: procedure
    .input(choice.extend({ sourceId: z.string() }))
    .mutation(({ input: { sourceId, ...choice }, ctx }) =>
      ready().backups.prepare(sourceId, {
        ...choice,
        ...(ctx.authorize ? { activateServices: false } : {}),
      }),
    ),
  backupStage: procedure
    .input(z.object({ previewId: z.string() }))
    .mutation(({ input, ctx }) =>
      applyBackupLive(
        () => ready().backups.stage(input.previewId),
        undefined,
        true,
        !ctx.authorize,
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
          pruneConfirmation: z.string().optional(),
        })
        .optional(),
    )
    .mutation(({ input, ctx }) => {
      const { clientId, pruneConfirmation, ...defaults } = input ?? {};
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
            'qqProxyEnabled',
            'qqProxyPort',
          ].includes(id),
        )
      )
        throw new Error('请在桌面端恢复本机连接与自启设置');
      let stagedId: string | undefined;
      function confirmedLogPlan() {
        const plan = planDefaultLogRetention(ready().config.getSettings());
        assertLogPruneConfirmed(plan, pruneConfirmation);
        return plan;
      }
      let logPlan: ReturnType<typeof confirmedLogPlan> = null;
      return applyBackupLive(
        confirmedLogPlan,
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
          const confirmed = logPlan;
          if (confirmed?.targets.size)
            await attempt('清理应用日志', () => {
              const { failed } = runLogRetentionSweep(DEFAULT_APP_SETTINGS, confirmed);
              if (failed) throw new Error(`${failed} 份日志未能删除`);
            });
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
              await attempt(`恢复${label}`, () =>
                desktopServiceCommand('remote.restore', [id], () =>
                  remoteRuntime.restorePreferences([id]),
                ),
              );
          if (selected.includes('webEnabled'))
            await attempt('恢复 Web 服务开关', () => setDesktopWebEnabled(false));
          if (selected.includes('qqProxyEnabled') || selected.includes('qqProxyPort'))
            await attempt('恢复 QQ 代理', async () => {
              const root = getAppContext().bootstrap?.qqSyncRoot;
              if (!root) throw new Error('QQ 代理配置尚未就绪');
              if (selected.includes('qqProxyEnabled')) await setQqSyncProxyEnabled(root, false);
              if (selected.includes('qqProxyPort')) await setQqSyncPort(root, DEFAULT_QQ_SYNC_PORT);
            });
          await attempt('关闭原生调试日志', disableNativeDebugLog);
          await attempt('保存恢复回执', () => recordWeqRestoreWarnings(ready().root, result));
        },
        false,
        true,
        () => {
          logPlan = confirmedLogPlan();
          stagedId = ready().backups.stageDefaults(clientId, defaults).id;
        },
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
      });
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
      if ((await desktopWebStatus()).enabled)
        connections.push({ id: 'webEnabled', label: 'Web 服务', value: '运行中' });
      const remote = await desktopServiceCommand('remote.preferences', undefined, () =>
        remoteRuntime.preferences(),
      );
      if (remote.enabled)
        connections.push({ id: 'remoteEnabled', label: '远程服务', value: '已启用' });
      if (remote.mode !== 'lan')
        connections.push({ id: 'remoteMode', label: '远程连接模式', value: remote.mode });
      if (remote.tailscaleEnabled)
        connections.push({ id: 'tailscaleEnabled', label: 'Tailscale 网络连接', value: '已启用' });
      const proxyRoot = getAppContext().bootstrap?.qqSyncRoot;
      if (proxyRoot) {
        const proxy = await qqSyncStatus(proxyRoot);
        if (proxy.enabled)
          connections.push({ id: 'qqProxyEnabled', label: 'QQ 代理开关', value: '已启用' });
        if (proxy.port !== DEFAULT_QQ_SYNC_PORT)
          connections.push({ id: 'qqProxyPort', label: 'QQ 代理端口', value: String(proxy.port) });
      }
    }
    return {
      ...boot.backups.defaultsInfo(),
      connections,
      logPrune: describeLogPrune(planDefaultLogRetention(settings)),
    };
  }),
  backupApply: procedure.mutation(({ ctx }) =>
    applyBackupLive(undefined, undefined, true, !ctx.authorize),
  ),
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

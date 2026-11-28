import { z } from 'zod/v3';
import { describeExportOutput, exportOutputFileName, getHost } from '@weq/service';
import { mediaSaveTaskDisplay } from '@weq/service/task-display';
import { getAppContext } from '../../context/app_context';
import { taskMessageSourceInput } from '../../task_message_source';
import { savedMediaSourceKey } from '../../message_media_local';
import { mediaTransferTarget } from '../../../shared/transfer_progress';
import {
  mediaSaveSourceInput,
  planSource,
  recoverableMedia,
  savePlannedMedia,
  type MediaResumeRequest,
} from '../../media_save';
import { procedure, router } from '../trpc';
import {
  bindExportSaveRequest,
  exportAccountBindingInput,
  exportSavePolicyInput,
  prepareExportDestination,
} from './export_save';

const saveInput = exportAccountBindingInput.extend({
  source: mediaSaveSourceInput,
  messageSource: taskMessageSourceInput.optional(),
  savePolicy: exportSavePolicyInput.optional(),
  foreground: z.boolean().optional(),
  browserOutput: z.boolean().optional(),
});

const mediaTaskRef = exportAccountBindingInput.extend({ taskId: z.string().min(1) });
function resolveMediaTask(input: z.infer<typeof mediaTaskRef>) {
  const context = getAppContext();
  bindExportSaveRequest(input, () => ({
    uin: context.account?.context.uin.toString(),
    configId: context.services?.accountConfig.getRecord()?.configId,
    services: context.services,
  }))();
  const manager = context.services?.exportManager;
  const task = manager?.getTask(input.taskId);
  return task?.resource?.kind === 'media' && manager ? { manager, task } : null;
}

export const mediaSaveRouter = router({
  save: procedure.input(saveInput).mutation(async ({ input }) => {
    const context = getAppContext(),
      services = context.services;
    if (!services) throw new Error('未打开账号');
    const selected = structuredClone(input);
    const check = bindExportSaveRequest(
      {
        expectedAccountUin: selected.expectedAccountUin ?? context.account?.context.uin.toString(),
        expectedAccountConfigId:
          selected.expectedAccountConfigId ?? services.accountConfig.getRecord()?.configId,
      },
      () => {
        const ctx = getAppContext();
        return {
          uin: ctx.account?.context.uin.toString(),
          configId: ctx.services?.accountConfig.getRecord()?.configId,
          services: ctx.services,
        };
      },
    );
    const plan = await planSource(services, selected.source, check);
    check();
    const output = describeExportOutput(
      { kind: 'file', name: plan.fileName, fileName: plan.fileName },
      { avatar: false, transcribe: false, ocr: false, dress: false },
    );
    if (output.kind !== 'file') throw new Error('媒体保存形态无效');
    const host = getHost();
    if (selected.browserOutput && !host.registerDownload)
      throw new Error('当前环境不支持浏览器下载');
    let policy: NonNullable<Awaited<ReturnType<typeof prepareExportDestination>>> | undefined;
    if (!selected.browserOutput) {
      const settings = context.bootstrap?.userConfig.getSettings();
      const destination = await prepareExportDestination(
        selected.savePolicy ?? { mode: settings?.exportSaveMode ?? 'before' },
        settings?.defaultExportDir,
        host,
        output,
        check,
        `media:${selected.source.kind}:${output.extension}`,
      );
      if (!destination) return null;
      policy = destination;
    }
    const fileName = exportOutputFileName(output);
    const source = selected.source;
    const recoverable = recoverableMedia(source);
    const resume: MediaResumeRequest | undefined = recoverable
      ? { type: 'media-file', source: recoverable, fileName }
      : undefined;
    return services.exportManager.startResourceExport({
      kind: 'media',
      foreground: selected.foreground,
      browserOutput: selected.browserOutput,
      resume,
      source: source.kind === 'group-file' ? undefined : selected.messageSource,
      sourceKey: savedMediaSourceKey(selected.source),
      transferTarget: mediaTransferTarget(selected.source),
      name: output.name,
      display: mediaSaveTaskDisplay(plan.kind, plan.fileName),
      output,
      savePolicy: policy,
      run: (context) =>
        savePlannedMedia(
          plan,
          fileName,
          context,
          check,
          source.kind === 'url' ? output.extension : undefined,
        ),
    });
  }),
  background: procedure
    .input(mediaTaskRef.extend({ unfinishedOnly: z.boolean().optional() }))
    .mutation(
      ({ input }) =>
        resolveMediaTask(input)?.manager.backgroundResourceTask(
          input.taskId,
          input.unfinishedOnly,
        ) ?? false,
    ),
  resume: procedure.input(mediaTaskRef).mutation(({ input }) => {
    const entry = resolveMediaTask(input);
    return entry?.task.status === 'paused' ? entry.manager.resumeTask(input.taskId) : false;
  }),
  cancel: procedure.input(mediaTaskRef).mutation(({ input }) => {
    const entry = resolveMediaTask(input);
    return entry && ['pending', 'running', 'paused'].includes(entry.task.status)
      ? entry.manager.cancelTask(input.taskId)
      : false;
  }),
});

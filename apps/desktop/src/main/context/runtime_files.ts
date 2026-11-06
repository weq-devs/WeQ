import { join } from 'node:path';
import {
  getAppContext,
  requireBootstrap,
  accountRuntimeCacheRoot,
  bootstrapRuntimeCacheRoot,
  blockRuntimeForBackupRecovery,
} from './app_context';
import { getBackupContext, applyLiveBackupContext } from './backup_context';
import { isDbRepairBusy } from '../ipc/routers/db_repair';
import { isIntentModelDownloading } from '../ipc/routers/intent_sense';
import { assistantResourceServer } from '../weq_assistant/server';
import { runtimeMaintenance } from '../runtime_maintenance';

export function assertRuntimeFilesIdle(): void {
  if (isDbRepairBusy()) throw new Error('数据库修复或回滚仍在进行，请等待完成');
  const ctx = getAppContext();
  if (
    ctx.services?.exportManager
      .listTasks()
      .some((task) => ['running', 'pending'].includes(task.status))
  )
    throw new Error('导出任务仍在进行，请先暂停或取消任务');
  const boot = ctx.bootstrap;
  if (
    isIntentModelDownloading() ||
    (boot &&
      [...boot.ocrModels.listModels(), ...boot.voiceTranscribe.listModels()].some(
        (model) => model.downloading,
      ))
  )
    throw new Error('模型仍在下载，请等待完成');
}

export function runtimeFileBusyPaths(): string[] {
  const ctx = getAppContext();
  const files = getBackupContext();
  const boot = requireBootstrap();
  const cache = boot.userConfig.cacheBaseDir();
  const paths = [
    join(files.root, 'config.json'),
    join(files.root, 'config'),
    join(bootstrapRuntimeCacheRoot() ?? cache, 'api_usage'),
  ];
  if (isDbRepairBusy()) {
    for (const name of ['db-repair', 'db_repair', 'dbfix', 'dbfix2']) paths.push(join(cache, name));
    const scratch = boot.userConfig.getDbRepairCacheDir();
    if (scratch) paths.push(scratch);
  }
  if (
    isIntentModelDownloading() ||
    [...boot.ocrModels.listModels(), ...boot.voiceTranscribe.listModels()].some(
      (model) => model.downloading,
    )
  )
    paths.push(join(files.root, 'models'));
  if (boot.userConfig.getSettings().weqAssistant.enabled) paths.push(join(cache, 'weq-assistant'));
  if (ctx.services) {
    const accountCache = accountRuntimeCacheRoot(ctx) ?? cache;
    for (const name of [
      'agentlab',
      'ocr',
      'roam-msg',
      'roaming-jobs',
      'export',
      'search-index',
      'content-search',
      'collection-history',
      'deleted',
      'anti_recall',
      'intent_sense',
      'db_tolerance',
      'flash',
    ])
      paths.push(join(accountCache, name));
  }
  return paths;
}

export function applyBackupLive(stage?: () => unknown) {
  return runtimeMaintenance.run(async () => {
    assertRuntimeFilesIdle();
    stage?.();
    const ctx = getAppContext();
    let failure: string | undefined;
    try {
      await ctx.clearAccount(true);
      await assistantResourceServer.stop();
      const result = applyLiveBackupContext();
      if (result.needsRecovery) blockRuntimeForBackupRecovery(result.error || '恢复回滚尚未完成');
      if (result.status !== 'applied') throw new Error(result.error || '恢复未应用');
      try {
        if (ctx.bootstrap)
          await ctx.applyWeqAssistant(ctx.bootstrap.userConfig.getSettings().weqAssistant);
      } catch (error) {
        result.warnings.push(`数据已恢复，助手服务未能启动：${String(error)}`);
      }
      return result;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      runtimeMaintenance.refreshClients(failure);
    }
  });
}

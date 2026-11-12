import { app } from 'electron';
import { join } from 'node:path';
import { getLogger } from '@weq/service';
import { loadQqSync, type QqSyncRuntime } from './qq_sync_loader';

let runtime: QqSyncRuntime | undefined;
let starting: Promise<void> | undefined;

/** 单实例主进程管理桥接，等待 QQ 启动。 */
export async function startDesktopQqSync(): Promise<void> {
  if (runtime || process.platform !== 'win32' || process.arch !== 'x64') return;
  if (starting) return starting;
  const logger = getLogger().child({ scope: 'qq-local-sync' });
  const root = app.isPackaged
    ? join(process.resourcesPath, 'qq-sync')
    : join(app.getAppPath(), '../../native/qq-sync');
  starting = loadQqSync(root)
    .then(({ startQqSync }) => {
      runtime = startQqSync({
        root,
        report: (event) =>
          logger.info('QQ 本机同步状态', {
            event: 'qq-local-sync',
            state: event.state,
            listeners: event.listeners,
            jobId: event.jobId,
            attempt: event.attempt,
            retryDelayMs: event.retryDelayMs,
            resultCode: event.resultCode,
            returned: event.returned,
            recordFound: event.recordFound,
            retryable: event.retryable,
            lookupSource: event.lookupSource,
            notifyState: event.notifyState,
            notifyCount: event.notifyCount,
            readState: event.readState,
          }),
      });
    })
    .catch(() => {
      logger.warn('QQ 本机同步组件未就绪，请拉取配套原生产物', {
        event: 'qq-local-sync-unavailable',
      });
    })
    .finally(() => {
      starting = undefined;
    });
  return starting;
}

export function getPrivateTextSentHandler(): QqSyncRuntime['enqueue'] | undefined {
  return runtime?.enqueue;
}

export async function stopDesktopQqSync(): Promise<void> {
  await starting;
  const active = runtime;
  runtime = undefined;
  await active?.stop();
}

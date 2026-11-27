import {
  networkCost,
  UNKNOWN_NETWORK,
  type NetworkCost,
  type DataSaverTemporaryRequest,
} from '@weq/service/data-saver';
import { getAppContext } from './context/app_context';
import { dataSaverSession, updateTransferPolicy } from '@weq/service/transfer-policy';
import { transferActivity, type TransferActivity } from '@weq/service/managed-download';
import { archiveCompletedTask, backgroundTasks } from './background_tasks';
import { onSettingsChanged } from '@weq/service/settings-changes';
import { unfinishedDataSaverTasks } from '../shared/data_saver_tasks';
import { forgetTaskOnPage, holdTaskOnPage } from './task_page';
import { z } from 'zod/v3';
import { networkScope } from '@weq/service/network-scope';
import { recordAccountTask } from './account_task_receipts';
import type { BackgroundTaskScope } from '../shared/background_task';

const originalRequest = z.object({
  type: z.literal('chat-original'),
  token: z.string().min(1).max(8192),
  originalUrl: z
    .string()
    .regex(/^\/(?!\/)[^?#]*$/)
    .optional(),
  ext: z
    .string()
    .regex(/^\.[a-z0-9]+$/i)
    .optional(),
  rkeyTypes: z.array(z.number().int()).optional(),
});

export function retryOriginalDownload(id: string, scope: BackgroundTaskScope, raw: unknown) {
  const parsed = originalRequest.parse(raw);
  const { account, services, platform } = getAppContext();
  const record = services?.accountConfig.getRecord();
  if (!services || record?.uin !== scope.uin || record.configId !== scope.configId)
    throw new Error('请回到原账号和数据源继续。');
  const task = backgroundTasks.snapshot().find((row) => row.id === id);
  if (!task || task.status === 'running') throw new Error('原图任务正在处理或已经失效。');
  backgroundTasks.resume(id);
  backgroundTasks.setActions(id, []);
  const save = recordAccountTask(id, scope, parsed);
  const completed = () =>
    backgroundTasks.snapshot().some((task) => task.id === id && task.status === 'completed');
  const work = networkScope.run(
    { restricted: false, ...networkScope.getStore(), override: true, intent: 'interactive' },
    () =>
      services.mediaDownload.download(parsed.token, {
        originalUrl: parsed.originalUrl,
        ext: parsed.ext,
        rkeyTypes: parsed.rkeyTypes,
        reportActivity: true,
        activityTaskId: id,
      }),
  );
  void work
    .then((path) => {
      if (completed()) return;
      if (getAppContext().account !== account) throw new Error('账号或数据源已切换。');
      if (!path) throw new Error('未取到原图，请检查 QQ 在线状态后重试。');
      backgroundTasks.resume(id);
      backgroundTasks.finish(id, 'completed', { note: '原图已缓存' });
      backgroundTasks.setActions(id, []);
      archiveCompletedTask(platform?.appDataRoot?.(), id);
    })
    .catch((error) => {
      if (completed()) return;
      backgroundTasks.resume(id);
      backgroundTasks.finish(id, 'failed', {
        note: error instanceof Error ? error.message : String(error),
      });
      backgroundTasks.setActions(id, [
        { id: 'retry', label: '继续下载原图', run: () => retryOriginalDownload(id, scope, raw) },
      ]);
    })
    .finally(() => {
      try {
        save();
      } catch (error) {
        console.warn('[原图] 任务回执保存失败', error);
      }
    });
}

const windowTasks = new Map<string, number | null>();
const taskSources = new Map<string, NonNullable<ReturnType<typeof getAppContext>['services']>>();
let taskTimer: ReturnType<typeof setInterval> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let watchingTasks = false;

export function reportDataSaverTasks(windowId: string, count?: number) {
  if (!windowTasks.has(windowId) && windowTasks.size >= 256)
    for (const [id, pendingCount] of windowTasks) if (pendingCount === 0) windowTasks.delete(id);
  if (!windowTasks.has(windowId) && windowTasks.size >= 256)
    throw new Error('省流量任务来源过多，请关闭不再使用的窗口');
  windowTasks.set(windowId, count ?? windowTasks.get(windowId) ?? null);
  if (watchingTasks) checkTasks();
}
export function closeDataSaverWindow(windowId: string) {
  windowTasks.delete(windowId);
  if (watchingTasks) checkTasks();
}
function readTaskCount(): number | null {
  if (!watchingTasks) taskSources.clear();
  const services = getAppContext().services;
  if (services) taskSources.set(services.accountConfig.getRecord()?.configId ?? '', services);
  if ([...windowTasks.values()].some((count) => count === null)) return null;
  try {
    let count = unfinishedDataSaverTasks({ background: [...backgroundTasks.snapshot()] });
    for (const source of taskSources.values()) {
      count += unfinishedDataSaverTasks({
        exports: source.exportManager.listTasks(),
        roaming: source.roamingBackfill.list(),
        scanning: source.roamingBackfill.scanning(),
        flash: source.flashTransferFiles.downloads.list(),
      });
      count += source.agentLab.runningBuildCount();
    }
    return count + [...windowTasks.values()].reduce<number>((sum, value) => sum + (value ?? 0), 0);
  } catch {
    return null;
  }
}
function checkTasks() {
  const count = readTaskCount();
  dataSaverSession.setPendingTasks(count);
  if (count !== 0 || dataSaverSession.status().temporary?.duration !== 'tasks') {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  } else if (!idleTimer) {
    // 给结束事件后的排队启动留出一轮；到时再读取真实状态，不用旧的零值。
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      dataSaverSession.setPendingTasks(readTaskCount());
      dataSaverSession.finishTasks();
    }, 1000);
    idleTimer.unref();
  }
}
export function dataSaverStatus(clientId?: string) {
  checkTasks();
  return dataSaverSession.status(clientId);
}
export function setTemporaryDataSaver(input: DataSaverTemporaryRequest, clientId?: string) {
  checkTasks();
  dataSaverSession.setTemporary(input);
  return dataSaverSession.status(clientId);
}

let last: NetworkCost = UNKNOWN_NETWORK;
let checked = 0;
let pending: Promise<NetworkCost> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
export async function refreshTransferPolicy() {
  startTransferPolicy();
  const cost = await hostNetworkCost();
  const preferences = getAppContext().bootstrap?.userConfig.getSharedPreference?.('client') ?? {};
  updateTransferPolicy(preferences.dataSaverMode ?? 'auto', cost, preferences);
  return cost;
}
export function startTransferPolicy() {
  if (!timer) {
    dataSaverSession.subscribe(() => {
      const active = dataSaverSession.status().temporary?.duration === 'tasks';
      if (active === watchingTasks) return;
      watchingTasks = active;
      if (active) {
        taskTimer = setInterval(checkTasks, 1000);
        taskTimer.unref();
      } else {
        if (taskTimer) clearInterval(taskTimer);
        if (idleTimer) clearTimeout(idleTimer);
        taskTimer = idleTimer = undefined;
        taskSources.clear();
      }
    });
    backgroundTasks.subscribe(() => {
      if (watchingTasks) checkTasks();
    });
    onSettingsChanged(() => {
      void refreshTransferPolicy().catch(() => undefined);
    });
    const ids = new Map<string, string>();
    const receipts = new Map<string, ReturnType<typeof recordAccountTask>>();
    transferActivity.on('state', (state: TransferActivity) => {
      let id = ids.get(state.id);
      if (!id) {
        const foreground = holdTaskOnPage(state.transfer.activityPageId, state.id, () => {
          const taskId = ids.get(state.id);
          if (taskId) backgroundTasks.setForeground(taskId, false);
        });
        const resume = state.transfer.activityResume;
        const config = resume ? getAppContext().services?.accountConfig.getRecord() : undefined;
        const scope = config?.configId ? { uin: config.uin, configId: config.configId } : undefined;
        const taskInput = {
          kind: 'resource',
          name: state.name,
          display: { action: '下载资源', subject: state.name },
          foreground,
          scope,
        } as const;
        if (resume && scope) {
          id = resume.id;
          if (!backgroundTasks.snapshot().some((task) => task.id === id)) {
            const now = Date.now();
            backgroundTasks.project(
              { ...taskInput, id, status: 'running', actions: [], startedAt: now, updatedAt: now },
              [],
            );
          }
          receipts.set(state.id, recordAccountTask(id, scope, resume.request));
        } else id = backgroundTasks.start(taskInput);
        try {
          receipts.get(state.id)?.();
        } catch (error) {
          console.warn('[原图] 任务回执保存失败', error);
        }
        ids.set(state.id, id);
      }
      if (state.done || state.error || state.cancelled) {
        backgroundTasks.resume(id);
        backgroundTasks.finish(
          id,
          state.cancelled ? 'cancelled' : state.error ? 'failed' : 'completed',
          { note: state.error },
        );
        const resume = state.transfer.activityResume;
        const scope = backgroundTasks.snapshot().find((task) => task.id === id)?.scope;
        backgroundTasks.setActions(
          id,
          resume && scope && (state.error || state.cancelled)
            ? [
                {
                  id: 'retry',
                  label: '继续下载原图',
                  run: () => retryOriginalDownload(id!, scope, resume.request),
                },
              ]
            : [],
        );
        if (state.done && resume && scope && originalRequest.safeParse(resume.request).success)
          archiveCompletedTask(getAppContext().platform?.appDataRoot?.(), id);
        try {
          receipts.get(state.id)?.();
        } catch (error) {
          console.warn('[原图] 任务回执保存失败', error);
        }
        receipts.delete(state.id);
        ids.delete(state.id);
        forgetTaskOnPage(state.id);
      } else if (state.paused) {
        backgroundTasks.finish(id, 'paused', {
          statusLabel: state.reasons.includes('user') ? '已暂停' : '省流量模式已暂停',
        });
        backgroundTasks.setActions(id, [
          { id: 'continue', label: '继续下载', run: () => state.transfer.continue() },
        ]);
        try {
          receipts.get(state.id)?.();
        } catch (error) {
          console.warn('[原图] 任务回执保存失败', error);
        }
      } else {
        backgroundTasks.resume(id);
        backgroundTasks.update(id, {
          progress: state.total ? (state.received / state.total) * 100 : undefined,
        });
        backgroundTasks.setActions(id, [
          { id: 'pause', label: '暂停', run: () => state.transfer.pause() },
        ]);
      }
    });
    timer = setInterval(() => void refreshTransferPolicy().catch(() => undefined), 5000);
    timer.unref();
  }
}
export function hostNetworkCost(): Promise<NetworkCost> {
  if (pending) return pending;
  if (Date.now() - checked < 5000) return Promise.resolve(last);
  pending = (async () => {
    try {
      const read = getAppContext().platform?.native.ntHelper.getNetworkCost;
      const value = await read?.();
      const next = value?.known
        ? networkCost(value.constrained, value.metered, value.source)
        : UNKNOWN_NETWORK;
      if (next.state !== 'unknown' || last.state === 'unknown') last = next;
    } catch {
      // 探测失败不冒充系统已解除限制。
    }
    checked = Date.now();
    return last;
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}
export async function hostDataSaver(clientRestricted = false): Promise<boolean> {
  try {
    // 媒体命中不能排队等系统探测，实时状态由独立轮询更新。
    void hostNetworkCost();
    const status = dataSaverSession.status();
    return status.effectiveMode !== 'never' && (clientRestricted || status.enabled);
  } catch {
    return false;
  }
}

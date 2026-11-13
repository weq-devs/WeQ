import type { ModelDownloadProgress } from '@weq/service';
import { backgroundTasks, runBackgroundTask } from './background_tasks';
import { transferBehavior } from '@weq/service/network-scope';

interface ModelStore {
  pauseDownload(id: string): void;
  continueDownload(id: string): void;
  on(event: 'progress', handler: (progress: ModelDownloadProgress) => void): unknown;
  off(event: 'progress', handler: (progress: ModelDownloadProgress) => void): unknown;
  downloadModel(id: string): Promise<{ success: boolean; error?: string }>;
}

const pending = new WeakMap<ModelStore, Map<string, Promise<unknown>>>();

/** 监听真实下载器，重复点击共享同一记录；页面关闭不影响进度与最终回执。 */
export function trackModelDownload(store: ModelStore, id: string, label: string) {
  let downloads = pending.get(store);
  if (!downloads) {
    downloads = new Map();
    pending.set(store, downloads);
  }
  if (downloads.has(id)) return downloads.get(id)!;
  const work = runBackgroundTask(
    { kind: 'model', name: `${label} · ${id}` },
    async (taskId) => {
      const progress = (p: ModelDownloadProgress) => {
        if (p.id !== id) return;
        if (p.paused) {
          backgroundTasks.finish(taskId, 'paused', {
            statusLabel: p.pauseReasons?.includes('user') ? '已暂停' : '省流量模式已暂停',
          });
          backgroundTasks.setActions(taskId, [
            { id: 'continue', label: '继续下载', run: () => store.continueDownload(id) },
          ]);
        } else {
          backgroundTasks.resume(taskId);
          backgroundTasks.setActions(taskId, [
            { id: 'pause', label: '暂停', run: () => store.pauseDownload(id) },
          ]);
        }
        backgroundTasks.update(taskId, {
          progress: p.percent,
          note: p.paused
            ? p.pauseReasons?.includes('user') || !transferBehavior().dataSaverAutoResume
              ? '等待手动继续'
              : '限制解除后自动继续，或手动继续此任务'
            : `${(p.downloadedBytes / 1024 / 1024).toFixed(1)} / ${(p.totalBytes / 1024 / 1024).toFixed(1)} MiB`,
        });
      };
      store.on('progress', progress);
      try {
        const result = await store.downloadModel(id);
        if (!result.success) throw new Error(result.error ?? '模型下载失败');
        return result;
      } finally {
        store.off('progress', progress);
      }
    },
    () => ({ note: '模型已下载' }),
  ).finally(() => downloads.delete(id));
  downloads.set(id, work);
  return work;
}

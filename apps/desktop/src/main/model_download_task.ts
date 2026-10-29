import type { ModelDownloadProgress } from '@weq/service';
import { backgroundTasks, runBackgroundTask } from './background_tasks';

interface ModelStore {
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
        backgroundTasks.update(taskId, {
          progress: p.percent,
          note: `${(p.downloadedBytes / 1024 / 1024).toFixed(1)} / ${(p.totalBytes / 1024 / 1024).toFixed(1)} MiB`,
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

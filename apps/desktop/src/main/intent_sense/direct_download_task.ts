import { join } from 'node:path';
import { JsonStore } from '@weq/service/json-store';
import { z } from 'zod/v3';
import { archiveCompletedTask, backgroundTasks, taskError } from '../background_tasks';
import {
  getActiveIntentSenseLocalEngine,
  getAppContext,
  type IntentSenseModelProgress,
} from '../context/app_context';
import { downloadTaskReceipt, downloadTaskSnapshot } from '../download_task_receipt';

export const intentDownloadInput = z.object({
  mirror: z.boolean(),
  modelId: z.enum(['auto', 'laya-multilingual', 'QWeQ-NineBird-v1']).optional(),
});
type DownloadInput = z.infer<typeof intentDownloadInput>;
const receipt = downloadTaskReceipt.extend({ request: intentDownloadInput });
const receiptFile = z.object({ current: receipt.optional() });
type ReceiptFile = z.infer<typeof receiptFile>;
const stores = new Map<string, JsonStore<ReceiptFile>>();
let running = false;
export const intentDownloadInProgress = () => running;
export const intentDownloadListeners = new Set<(progress: IntentSenseModelProgress) => void>();

function storeForHost() {
  const root = getAppContext().platform?.appDataRoot?.();
  if (!root) return;
  const path = join(root, 'config', 'intent-download-task.json');
  let store = stores.get(path);
  if (!store) {
    store = new JsonStore<ReceiptFile>(path, () => ({}), {
      normalize: (value) => receiptFile.parse(value),
    });
    stores.set(path, store);
  }
  return store;
}

function presentation({ modelId }: DownloadInput) {
  return {
    kind: 'model' as const,
    name: `本地意图模型 · ${modelId ?? 'auto'}`,
    display: { action: '下载意图模型', subject: modelId === 'auto' ? undefined : modelId },
  };
}

function continueAction(id: string, input: DownloadInput, action: 'retry' | 'continue') {
  return {
    id: action,
    label: action === 'continue' ? '继续下载' : '重试下载',
    run: () => {
      if (running) throw new Error('意图模型正在下载。');
      if (!getActiveIntentSenseLocalEngine()) throw new Error('当前宿主未提供本地引擎。');
      void startDirectIntentDownload(input, id);
    },
  };
}

export function restoreDirectIntentDownload() {
  if (getAppContext().bootstrap?.enhancements?.packs || running) return;
  const saved = storeForHost()?.data.current;
  if (!saved || backgroundTasks.snapshot().some(({ id }) => id === saved.id)) return;
  const { request, ...task } = saved;
  const interrupted = task.status === 'running' || task.status === 'paused';
  backgroundTasks.project(
    {
      ...task,
      ...presentation(request),
      status: interrupted ? 'paused' : task.status,
      statusLabel: interrupted ? '等待继续下载' : task.statusLabel,
      note: interrupted ? '已完成的模型文件可在继续时复用。' : task.note,
      actions: [],
    },
    interrupted || task.status === 'failed'
      ? [continueAction(task.id, request, interrupted ? 'continue' : 'retry')]
      : [],
  );
  archiveCompletedTask(getAppContext().platform?.appDataRoot?.(), saved.id);
}

export function forgetDirectIntentDownload(id: string) {
  const store = storeForHost();
  if (store?.data.current?.id === id) store.replace({}, true);
}

export async function startDirectIntentDownload(input: DownloadInput, existingId?: string) {
  const engine = getActiveIntentSenseLocalEngine();
  if (!engine) return { ok: false, error: '当前宿主未提供本地引擎', alreadyRunning: false };
  if (running) return { ok: true, alreadyRunning: true };
  const store = storeForHost();
  const saved = store?.data.current;
  const reusable =
    saved &&
    (saved.status === 'running' || saved.status === 'paused' || saved.status === 'failed') &&
    saved.request.modelId === input.modelId &&
    saved.request.mirror === input.mirror;
  if (reusable && !existingId) restoreDirectIntentDownload();
  const id = existingId ?? (reusable ? saved.id : backgroundTasks.start(presentation(input)));
  running = true;
  const save = () => {
    const task = backgroundTasks.snapshot().find((row) => row.id === id);
    if (task) store?.replace({ current: { ...downloadTaskSnapshot(task), request: input } }, true);
  };
  backgroundTasks.resume(id);
  backgroundTasks.setActions(id, []);
  const notify = (progress: IntentSenseModelProgress) => {
    backgroundTasks.update(id, {
      progress:
        progress.filesTotal > 0 ? (progress.filesDone / progress.filesTotal) * 100 : undefined,
      note: `${progress.filesDone} / ${progress.filesTotal} 个文件${progress.currentFile ? ` · ${progress.currentFile}` : ''}`,
    });
    for (const listener of intentDownloadListeners) {
      try {
        listener(progress);
      } catch {
        /* 监听器异常不影响下载。 */
      }
    }
  };
  try {
    save();
    notify({ filesDone: 0, filesTotal: 5, received: 0, total: 0, currentFile: null, done: false });
    await engine.download({ ...input, onProgress: notify });
    backgroundTasks.finish(id, 'completed', { note: '模型已下载' });
    archiveCompletedTask(getAppContext().platform?.appDataRoot?.(), id);
    return { ok: true, alreadyRunning: false };
  } catch (error) {
    backgroundTasks.finish(id, 'failed', { note: taskError(error) });
    backgroundTasks.setActions(id, [continueAction(id, input, 'retry')]);
    return { ok: false, error: taskError(error), alreadyRunning: false };
  } finally {
    running = false;
    try {
      save();
    } catch (error) {
      console.warn('[意图模型] 任务回执保存失败', error);
    }
  }
}

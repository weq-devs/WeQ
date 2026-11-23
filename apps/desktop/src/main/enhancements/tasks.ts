import { JsonStore } from '@weq/service/json-store';
import { z } from 'zod';
import { join } from 'node:path';
import { ENHANCEMENT_PACK_IDS, type EnhancementPackId } from '../../shared/enhancement_manifest';
import type { EnhancementPacks, PackOperation } from './packs';
import { backgroundTasks, taskError } from '../background_tasks';
import { downloadTaskReceipt, downloadTaskSnapshot } from '../download_task_receipt';

interface PreparationTaskPort {
  list(): Promise<
    Array<{ id: EnhancementPackId; ready: boolean; operation?: PackOperation | null }>
  >;
  waitFor(id: EnhancementPackId): Promise<void>;
  start?(ids: readonly EnhancementPackId[]): void;
  pause?(id: EnhancementPackId): void;
  resume?(id: EnhancementPackId): void;
}
const pending = new WeakMap<PreparationTaskPort, Map<EnhancementPackId, Promise<void>>>();
const requestedActions = new WeakMap<
  PreparationTaskPort,
  Map<EnhancementPackId, { action: string; foreground: boolean }>
>();
const taskIds = new WeakMap<PreparationTaskPort, Map<EnhancementPackId, string>>();
const enhancementReceipt = downloadTaskReceipt.extend({ name: z.string(), action: z.string() });
const enhancementReceipts = z.record(z.enum(ENHANCEMENT_PACK_IDS), enhancementReceipt);
const stores = new WeakMap<PreparationTaskPort, JsonStore<z.infer<typeof enhancementReceipts>>>();

function presentation(name: string, action: string) {
  return {
    kind: 'model' as const,
    name,
    destination: 'enhancement-packs' as const,
    display: { action, subject: name, category: '增强包' },
  };
}

export function restoreEnhancementTasks(packs: EnhancementPacks, directory: string) {
  if (stores.has(packs)) return;
  const store = new JsonStore<z.infer<typeof enhancementReceipts>>(
    join(directory, 'download-tasks.json'),
    () => ({}),
    {
      normalize: (value) => enhancementReceipts.parse(value),
    },
  );
  stores.set(packs, store);
  for (const id of ENHANCEMENT_PACK_IDS) {
    if (!packs.isEnabled(id)) continue;
    const saved = store.data[id];
    if (!saved) continue;
    const status = saved.status === 'running' ? 'paused' : saved.status;
    backgroundTasks.project(
      {
        ...saved,
        ...presentation(saved.name, saved.action),
        status,
        statusLabel: status === 'paused' ? '等待继续' : saved.statusLabel,
        note:
          status === 'paused' ? '上次准备已中断，继续时会复核兼容版本并复用可用资源。' : saved.note,
        actions: [],
      },
      status === 'paused' || status === 'failed'
        ? [
            {
              id: status === 'paused' ? 'continue' : 'retry',
              label: status === 'paused' ? '继续下载' : '重试',
              run: async () => {
                await startEnhancementDownloads(packs, [id]);
                if (status === 'paused') packs.resume(id);
              },
            },
          ]
        : [],
    );
  }
}

export function enhancementTaskNeedsInput(packs: EnhancementPacks, id: EnhancementPackId) {
  const status = stores.get(packs)?.data[id]?.status;
  return status === 'running' || status === 'paused' || status === 'failed';
}

export function enhancementDownloadTask(packs: PreparationTaskPort, id: EnhancementPackId) {
  const taskId = taskIds.get(packs)?.get(id) ?? stores.get(packs)?.data[id]?.id;
  const task = backgroundTasks.snapshot().find((entry) => entry.id === taskId);
  if (!task) return null;
  const { status, statusLabel, progress, note, foreground } = task;
  return { id: task.id, status, statusLabel, progress, note, foreground };
}

export function backgroundEnhancementDownload(
  packs: PreparationTaskPort,
  id: EnhancementPackId,
  taskId: string,
) {
  const task = enhancementDownloadTask(packs, id);
  if (task?.id !== taskId) throw new Error('增强包下载已改变，请刷新');
  if (!task.foreground) return;
  const store = stores.get(packs);
  const saved = store?.data[id];
  if (store && saved?.id === taskId) {
    store.replace({ ...store.data, [id]: { ...saved, foreground: false } }, true);
  }
  backgroundTasks.setForeground(taskId, false);
}

export function forgetEnhancementTask(packs: EnhancementPacks, taskId: string): boolean {
  const store = stores.get(packs);
  const id = ENHANCEMENT_PACK_IDS.find((key) => store?.data[key]?.id === taskId);
  if (!store || !id) return true;
  if (packs.isPreparing(id) || pending.get(packs)?.has(id)) return false;
  const next = { ...store.data };
  delete next[id];
  store.replace(next, true);
  return true;
}

export function forgetRemovedPackTask(packs: EnhancementPacks, id: EnhancementPackId) {
  const taskId = stores.get(packs)?.data[id]?.id;
  if (taskId && forgetEnhancementTask(packs, taskId)) backgroundTasks.remove(taskId);
}

export async function startEnhancementDownloads(
  packs: EnhancementPacks,
  requested: readonly EnhancementPackId[],
  foreground = false,
): Promise<void> {
  const previous = await packs.list();
  const ids = [...new Set(requested)].filter(
    (id) => !previous.find((pack) => pack.id === id)?.busy,
  );
  // start 会同步通知准备观察者，先固定本次操作意图，两个入口共用同一任务。
  const actions = new Map(
    ids.map((id) => {
      const pack = previous.find((entry) => entry.id === id);
      return [
        id,
        {
          foreground,
          action: !pack
            ? '准备增强包'
            : pack.needsRepair
              ? '补齐增强包'
              : pack.installed
                ? '更新增强包'
                : '安装增强包',
        },
      ];
    }),
  );
  requestedActions.set(packs, actions);
  try {
    packs.start(ids);
  } finally {
    requestedActions.delete(packs);
  }
  for (const id of ids) {
    const pack = previous.find((entry) => entry.id === id);
    if (pack)
      void trackEnhancementPreparation(
        packs,
        id,
        pack.name,
        actions.get(id)?.action,
        foreground,
      ).catch(() => {});
  }
}

/** 一次能力包准备只登记一个任务，组件阶段直接更新母任务，不再创建并列子任务。 */
export function trackEnhancementPreparation(
  packs: PreparationTaskPort,
  id: EnhancementPackId,
  name: string,
  action = requestedActions.get(packs)?.get(id)?.action ?? '准备增强包',
  foreground = requestedActions.get(packs)?.get(id)?.foreground,
): Promise<void> {
  let tasks = pending.get(packs);
  if (!tasks) {
    tasks = new Map();
    pending.set(packs, tasks);
  }
  const existing = tasks.get(id);
  if (existing) return existing;
  const store = stores.get(packs);
  const saved = store?.data[id];
  const useSaved =
    saved &&
    (saved.status === 'running' || saved.status === 'paused' || saved.status === 'failed') &&
    backgroundTasks.snapshot().some((entry) => entry.id === saved.id);
  const taskId = useSaved
    ? saved.id
    : backgroundTasks.start({ ...presentation(name, action), foreground });
  const ids = taskIds.get(packs) ?? new Map<EnhancementPackId, string>();
  ids.set(id, taskId);
  taskIds.set(packs, ids);
  if (useSaved && foreground !== undefined) backgroundTasks.setForeground(taskId, foreground);
  if (useSaved) action = saved.action;
  const persist = () => {
    const task = backgroundTasks.snapshot().find((entry) => entry.id === taskId);
    if (!task || !store) return;
    const previous = store.data[id];
    if (
      previous?.id === taskId &&
      previous.status === task.status &&
      previous.foreground === task.foreground &&
      previous.statusLabel === task.statusLabel
    )
      return;
    try {
      store.replace({ ...store.data, [id]: { ...downloadTaskSnapshot(task), name, action } }, true);
    } catch (error) {
      console.warn('[增强包] 任务记录保存失败', error);
    }
  };
  const pause = { id: 'pause', label: '暂停', run: () => packs.pause?.(id) };
  backgroundTasks.resume(taskId);
  backgroundTasks.setActions(taskId, packs.pause ? [pause] : []);
  persist();
  let polling = true;
  let updating = false;
  const update = async () => {
    if (updating) return;
    updating = true;
    try {
      const current = (await packs.list()).find((entry) => entry.id === id);
      if (!polling) return;
      const operation = current?.operation;
      const patch = {
        progress: operation?.total
          ? Math.min(99, (operation.received / operation.total) * 100)
          : undefined,
        note: `${operation?.retryAt && operation.retryAt > Date.now() ? '等待自动重试' : (operation?.note ?? (operation?.phase === 'queued' ? '等待准备' : '检查资源'))}${operation?.source ? ` · ${operation.source}` : ''}${operation?.total ? ` · ${(operation.received / 1048576).toFixed(1)} / ${(operation.total / 1048576).toFixed(1)} MiB` : ''}`,
      };
      if (operation?.paused) {
        backgroundTasks.finish(taskId, 'paused', {
          ...patch,
          statusLabel: operation.pauseReasons?.includes('user')
            ? '已暂停'
            : operation.pauseReasons?.includes('resume-required')
              ? '等待继续'
              : '省流量模式已暂停',
        });
        backgroundTasks.setActions(
          taskId,
          packs.resume
            ? [{ id: 'continue', label: '继续下载', run: () => packs.resume?.(id) }]
            : [],
        );
      } else {
        backgroundTasks.resume(taskId);
        backgroundTasks.update(taskId, patch);
        backgroundTasks.setActions(
          taskId,
          packs.pause && operation?.phase !== 'installing' ? [pause] : [],
        );
      }
      persist();
    } finally {
      updating = false;
    }
  };
  const timer = setInterval(() => void update().catch(() => {}), 750);
  const task = (async () => {
    try {
      await packs.waitFor(id);
      const current = (await packs.list()).find((entry) => entry.id === id);
      if (!current?.ready || current.operation?.phase === 'failed')
        throw new Error(current?.operation?.error ?? '增强包未准备完成');
      backgroundTasks.resume(taskId);
      backgroundTasks.finish(taskId, 'completed', { note: '增强包已就绪' });
      backgroundTasks.setActions(taskId, []);
    } catch (error) {
      backgroundTasks.resume(taskId);
      backgroundTasks.finish(taskId, 'failed', { note: taskError(error) });
      backgroundTasks.setActions(
        taskId,
        packs.start
          ? [
              {
                id: 'retry',
                label: '重试',
                run: () => {
                  packs.start?.([id]);
                  void trackEnhancementPreparation(packs, id, name, action).catch(() => {});
                },
              },
            ]
          : [],
      );
      throw error;
    } finally {
      polling = false;
      clearInterval(timer);
      persist();
      tasks!.delete(id);
    }
  })();
  tasks.set(id, task);
  return task;
}

import type { EnhancementPackId } from '../../shared/enhancement_manifest';
import type { EnhancementPacks, PackOperation } from './packs';
import { backgroundTasks, runBackgroundTask } from '../background_tasks';

interface PreparationTaskPort {
  list(): Promise<
    Array<{ id: EnhancementPackId; ready: boolean; operation?: PackOperation | null }>
  >;
  waitFor(id: EnhancementPackId): Promise<void>;
  resume?(id: EnhancementPackId): void;
}
const pending = new WeakMap<PreparationTaskPort, Map<EnhancementPackId, Promise<void>>>();

export async function startEnhancementDownloads(
  packs: EnhancementPacks,
  requested: readonly EnhancementPackId[],
): Promise<void> {
  const previous = await packs.list();
  const ids = [...new Set(requested)].filter(
    (id) => !previous.find((pack) => pack.id === id)?.busy,
  );
  packs.start(ids);
  for (const id of ids) {
    const pack = previous.find((entry) => entry.id === id)!;
    void trackEnhancementPreparation(packs, id, pack.name).catch(() => {});
  }
}

/** 一次能力包准备只登记一个任务，组件阶段直接更新母任务，不再创建并列子任务。 */
export function trackEnhancementPreparation(
  packs: PreparationTaskPort,
  id: EnhancementPackId,
  name: string,
): Promise<void> {
  let tasks = pending.get(packs);
  if (!tasks) {
    tasks = new Map();
    pending.set(packs, tasks);
  }
  const existing = tasks.get(id);
  if (existing) return existing;
  const task = runBackgroundTask(
    { kind: 'model', name },
    async (taskId) => {
      let polling = true;
      const update = async () => {
        const current = (await packs.list()).find((entry) => entry.id === id);
        if (!polling) return;
        const operation = current?.operation;
        if (operation?.paused) {
          backgroundTasks.finish(taskId, 'paused', { statusLabel: '已暂停' });
          backgroundTasks.setActions(
            taskId,
            packs.resume
              ? [{ id: 'continue', label: '继续下载', run: () => packs.resume?.(id) }]
              : [],
          );
        } else {
          backgroundTasks.resume(taskId);
          backgroundTasks.setActions(taskId, []);
        }
        backgroundTasks.update(taskId, {
          progress: operation?.total
            ? Math.min(99, (operation.received / operation.total) * 100)
            : undefined,
          note: `${operation?.note ?? (operation?.phase === 'queued' ? '等待准备' : '检查资源')}${operation?.total ? ` · ${(operation.received / 1048576).toFixed(1)} / ${(operation.total / 1048576).toFixed(1)} MiB` : ''}`,
        });
      };
      const timer = setInterval(() => {
        void update().catch(() => {});
      }, 750);
      try {
        await packs.waitFor(id);
        const current = (await packs.list()).find((entry) => entry.id === id);
        backgroundTasks.resume(taskId);
        backgroundTasks.setActions(taskId, []);
        if (!current?.ready) throw new Error(current?.operation?.error ?? '增强包未准备完成');
      } finally {
        polling = false;
        clearInterval(timer);
      }
    },
    () => ({ note: '增强包已就绪' }),
  ).finally(() => tasks!.delete(id));
  tasks.set(id, task);
  return task;
}

import { client, trpc } from '../trpc/client';
import { replaceEqualDeep } from '@tanstack/react-query';
import type { AppRouter } from '../../../main/ipc/router';
import type { inferRouterInputs } from '@trpc/server';
import type {
  TaskArchive,
  TaskArchiveChange,
  TaskArchiveSummaries,
} from '../../../shared/task_archive';

type Routes = inferRouterInputs<AppRouter>['taskArchive'];
export type TaskArchiveBinding = Routes['list'];
export type TaskArchiveRef = Routes['change']['tasks'][number];
export type TaskArchiveAction = Routes['change']['action'];
const empty: TaskArchive = {};
const unbound = { expectedAccountUin: '', expectedAccountConfigId: '' };

export function applyTaskArchiveChange(current: TaskArchiveSummaries, change: TaskArchiveChange) {
  if (current.generation !== change.generation) return undefined;
  if (change.revision <= current.revision) return current;
  if (change.revision !== current.revision + 1 || !change.patch) return undefined;
  const entries = { ...current.entries };
  for (const [id, entry] of Object.entries(change.patch)) {
    if (entry) entries[id] = entry;
    else delete entries[id];
  }
  return { generation: change.generation, revision: change.revision, entries };
}

function updateSummaries(
  utils: ReturnType<typeof trpc.useUtils>,
  binding: TaskArchiveBinding,
  change: TaskArchiveChange,
) {
  const current = utils.taskArchive.summaries.getData(binding);
  const next = current && applyTaskArchiveChange(current, change);
  if (!next) return utils.taskArchive.summaries.invalidate(binding);
  if (next !== current) utils.taskArchive.summaries.setData(binding, next);
}

export function useTaskArchive(binding: TaskArchiveBinding | null | undefined, enabled = true) {
  const utils = trpc.useUtils();
  const query = trpc.taskArchive.summaries.useQuery(binding ?? unbound, {
    enabled: Boolean(binding) && enabled,
    staleTime: 5000,
    keepPreviousData: false,
    structuralSharing: (previous, next) => {
      const current = previous as TaskArchiveSummaries | undefined;
      return current?.generation === next.generation && current.revision > next.revision
        ? current
        : replaceEqualDeep(current, next);
    },
  });
  return {
    entries: query.data?.entries ?? empty,
    ready: !binding || query.data !== undefined,
    error: query.error,
    async change(action: TaskArchiveAction, tasks: TaskArchiveRef[]) {
      if (!binding || !tasks.length) return 0;
      let changed = 0;
      for (let offset = 0; offset < tasks.length; offset += 500) {
        const result = await client.taskArchive.change.mutate({
          ...binding,
          action,
          tasks: tasks.slice(offset, offset + 500),
        });
        // 版本连续时只应用本次变更，慢回执不会覆盖其它窗口已应用的新版本。
        if (result.delta) await updateSummaries(utils, binding, result.delta);
        else if (result.changed) await utils.taskArchive.summaries.invalidate(binding);
        changed += result.changed;
      }
      return changed;
    },
    async resume(task: TaskArchiveRef) {
      if (!binding) return false;
      const { resumed, delta } = await client.taskArchive.resume.mutate({ ...binding, task });
      if (delta) await updateSummaries(utils, binding, delta);
      return resumed;
    },
    async remove(task: TaskArchiveRef) {
      if (!binding) return false;
      const removed = await client.taskArchive.remove.mutate({ ...binding, task });
      if (removed) await utils.taskArchive.summaries.invalidate(binding);
      return removed;
    },
  };
}

export function useTaskArchiveChanges(binding: TaskArchiveBinding | null, enabled: boolean) {
  const utils = trpc.useUtils();
  trpc.taskArchive.changes.useSubscription(binding ?? unbound, {
    enabled: Boolean(binding) && enabled,
    onData: (change) => {
      if (binding) void updateSummaries(utils, binding, change);
    },
  });
}

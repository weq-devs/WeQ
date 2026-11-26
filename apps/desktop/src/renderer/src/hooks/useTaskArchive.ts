import { client, trpc } from '../trpc/client';
import type { AppRouter } from '../../../main/ipc/router';
import type { inferRouterInputs } from '@trpc/server';
import type { TaskArchive } from '../../../shared/task_archive';

type Routes = inferRouterInputs<AppRouter>['taskArchive'];
export type TaskArchiveBinding = Routes['list'];
export type TaskArchiveRef = Routes['change']['tasks'][number];
export type TaskArchiveAction = Routes['change']['action'];
const empty: TaskArchive = {};
const unbound = { expectedAccountUin: '', expectedAccountConfigId: '' };

export function useTaskArchive(binding: TaskArchiveBinding | null | undefined, enabled = true) {
  const utils = trpc.useUtils();
  const query = trpc.taskArchive.list.useQuery(binding ?? unbound, {
    enabled: Boolean(binding) && enabled,
    staleTime: 5000,
    keepPreviousData: false,
  });
  return {
    entries: query.data ?? empty,
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
        // 读最新的宿主快照，避免慢响应覆盖其他窗口刚保存的结果。
        changed += result.changed;
      }
      await utils.taskArchive.list.invalidate(binding);
      return changed;
    },
    async remove(task: TaskArchiveRef) {
      if (!binding) return false;
      const removed = await client.taskArchive.remove.mutate({ ...binding, task });
      await utils.taskArchive.list.invalidate(binding);
      return removed;
    },
  };
}

export function useTaskArchiveChanges(binding: TaskArchiveBinding | null, enabled: boolean) {
  const utils = trpc.useUtils();
  trpc.taskArchive.changed.useSubscription(binding ?? unbound, {
    enabled: Boolean(binding) && enabled,
    onData: () => {
      if (binding) void utils.taskArchive.list.invalidate(binding);
    },
  });
}

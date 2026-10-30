import { useMemo, useSyncExternalStore } from 'react';
import { client, trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { localBackgroundTasks } from '../state/backgroundTasks';
import {
  backgroundTaskVisible,
  type BackgroundTask,
  type BackgroundTaskScope,
} from '../../../shared/background_task';

export interface BackgroundTaskEntry {
  task: BackgroundTask;
  source: 'host' | 'window';
}

export function backgroundTaskId(entry: BackgroundTaskEntry) {
  return `background:${entry.source}:${entry.task.id}`;
}

export async function removeBackgroundTask(
  entry: BackgroundTaskEntry,
  scope: BackgroundTaskScope | null,
) {
  if (entry.source === 'window') return localBackgroundTasks.remove(entry.task.id, entry.task);
  return client.backgroundTasks.remove.mutate({
    id: entry.task.id,
    updatedAt: entry.task.updatedAt,
    scope,
  });
}

export function useBackgroundTasks(enabled: boolean) {
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: enabled && Boolean(uin),
  });
  const configId = config.data?.uin === uin ? config.data.configId : undefined;
  const scope = useMemo(() => (uin ? { uin, configId } : null), [uin, configId]);
  const host = trpc.backgroundTasks.list.useQuery(scope, {
    enabled,
    refetchInterval: enabled ? 1000 : false,
    keepPreviousData: false,
  });
  const local = useSyncExternalStore(localBackgroundTasks.subscribe, localBackgroundTasks.snapshot);
  const tasks = useMemo<BackgroundTaskEntry[]>(
    () => [
      ...(host.data ?? [])
        .filter((task) => backgroundTaskVisible(task, scope))
        .map((task) => ({ task, source: 'host' as const })),
      ...local
        .filter((task) => backgroundTaskVisible(task, scope))
        .map((task) => ({ task, source: 'window' as const })),
    ],
    [host.data, local, scope],
  );
  return { tasks, scope, query: host };
}

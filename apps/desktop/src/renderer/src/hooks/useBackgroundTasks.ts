import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { forgetWindowTask, localBackgroundTasks } from '../state/backgroundTasks';
import { backgroundResult, type TaskArchive } from '../../../shared/task_archive';
import { backgroundTaskVisible, type BackgroundTask } from '../../../shared/background_task';

export interface BackgroundTaskEntry {
  task: BackgroundTask;
  source: 'host' | 'window' | 'saved';
  savedId?: string;
}

export function backgroundTaskId(entry: BackgroundTaskEntry) {
  return entry.savedId ?? `background:${entry.source}:${entry.task.id}`;
}

export function useBackgroundTasks(enabled: boolean, archive?: TaskArchive) {
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: enabled && Boolean(uin),
  });
  const configId = config.data?.uin === uin ? config.data.configId : undefined;
  const scope = useMemo(() => (uin ? { uin, configId } : null), [uin, configId]);
  const host = trpc.backgroundTasks.list.useQuery(scope, {
    enabled: enabled && (!uin || Boolean(configId)),
    refetchInterval: enabled ? 1000 : false,
    keepPreviousData: false,
  });
  const local = useSyncExternalStore(localBackgroundTasks.subscribe, localBackgroundTasks.snapshot);
  const tasks = useMemo<BackgroundTaskEntry[]>(() => {
    const current: BackgroundTaskEntry[] = [
      ...(host.data ?? [])
        .filter((task) => !task.foreground && backgroundTaskVisible(task, scope))
        .map((task) => ({ task, source: 'host' as const })),
      ...local
        .filter((task) => !task.foreground && backgroundTaskVisible(task, scope))
        .map((task) => ({ task, source: 'window' as const })),
    ];
    const ids = new Set(current.map(backgroundTaskId));
    for (const [savedId, entry] of Object.entries(archive ?? {})) {
      if (entry.snapshot && !ids.has(savedId) && backgroundTaskVisible(entry.snapshot, scope))
        current.push({ task: entry.snapshot, source: 'saved', savedId });
    }
    return current.flatMap((entry) => {
      const row = archive?.[backgroundTaskId(entry)];
      if (row?.result !== backgroundResult(entry.task)) return [entry];
      if (row.deleted) return [];
      if (row.verified && entry.task.needsConfirmation)
        return [
          {
            ...entry,
            task: { ...entry.task, needsConfirmation: false, statusLabel: '已核对结果' },
          },
        ];
      return [entry];
    });
  }, [host.data, local, scope, archive]);
  useEffect(() => {
    for (const task of local) {
      if (!backgroundTaskVisible(task, scope)) continue;
      const row = archive?.[`background:window:${task.id}`];
      if (
        row?.deleted &&
        row.result === backgroundResult(task) &&
        localBackgroundTasks.remove(task.id, task)
      )
        forgetWindowTask(task.id);
    }
  }, [archive, local, scope]);
  const error = host.error ?? (uin && !configId ? config.error : null);
  return { tasks, scope, query: host, error };
}

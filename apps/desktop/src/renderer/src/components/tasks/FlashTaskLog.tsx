import { useRef } from 'react';
import { trpc } from '../../trpc/client';
import { TaskActivityLog } from './TaskActivityLog';
import type { TaskLogLine } from '../TaskLogConsole';
import { usePageDataCache } from '../PageSnapshots.shared';

export function FlashTaskLog({
  taskId,
  version,
  binding,
}: {
  taskId: string;
  version: number;
  binding?: { expectedAccountUin: string; expectedAccountConfigId: string } | null;
}) {
  const cache = usePageDataCache();
  const cacheKey = JSON.stringify(['flash-task-logs', taskId, binding]);
  const query = trpc.account.flashDownloadTaskLogs.useQuery(
    {
      taskId,
      version,
      expectedAccountUin: binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: binding?.expectedAccountConfigId ?? '',
    },
    {
      enabled: Boolean(binding),
      cacheTime: 0,
      staleTime: 0,
      refetchOnMount: 'always',
      keepPreviousData: true,
      placeholderData: () => cache.read<TaskLogLine[]>(cacheKey),
      onSuccess: (data) => cache.write(cacheKey, data),
    },
  );
  const retained = useRef(query.data);
  if (query.data) retained.current = query.data;
  return (
    <TaskActivityLog
      lines={query.data ?? retained.current ?? []}
      loading={query.isLoading}
      error={query.error?.message}
    />
  );
}

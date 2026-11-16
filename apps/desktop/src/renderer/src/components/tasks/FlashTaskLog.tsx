import { useRef } from 'react';
import { trpc } from '../../trpc/client';
import { TaskActivityLog } from './TaskActivityLog';

export function FlashTaskLog({
  taskId,
  version,
  binding,
}: {
  taskId: string;
  version: number;
  binding?: { expectedAccountUin: string; expectedAccountConfigId: string } | null;
}) {
  const query = trpc.account.flashDownloadTaskLogs.useQuery(
    {
      taskId,
      version,
      expectedAccountUin: binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: binding?.expectedAccountConfigId ?? '',
    },
    { enabled: Boolean(binding), cacheTime: 0, keepPreviousData: true },
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

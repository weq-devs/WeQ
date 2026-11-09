import { useState } from 'react';
import type { BackgroundTaskScope } from '../../../shared/background_task';
import { trpc } from '../trpc/client';
import { TaskLogDisclosure } from './TaskLogDisclosure';

export function CalendarTaskLog({
  id,
  scope,
  updatedAt,
}: {
  id: string;
  scope: BackgroundTaskScope | null;
  updatedAt: number;
}) {
  const [open, setOpen] = useState(false);
  const logs = trpc.backgroundTasks.logs.useQuery(
    { id, scope, updatedAt },
    { enabled: open, cacheTime: 0 },
  );
  return (
    <TaskLogDisclosure
      open={open}
      onOpenChange={setOpen}
      lines={logs.data ?? []}
      error={logs.error?.message}
    />
  );
}

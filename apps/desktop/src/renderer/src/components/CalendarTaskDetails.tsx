import { useState } from 'react';
import type { CalendarControlAction } from '@weq/service/conversation-calendar';
import type { BackgroundTaskScope } from '../../../shared/background_task';
import { client, trpc } from '../trpc/client';
import { CalendarStatisticsProgress } from './CalendarStatisticsProgress';

export function CalendarTaskDetails({
  taskId,
  scope,
  running,
}: {
  taskId: string;
  scope: BackgroundTaskScope | null;
  running: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const binding = { expectedAccountUin: scope?.uin, expectedAccountConfigId: scope?.configId };
  const query = trpc.account.calendarOverview.task.useQuery(
    { ...binding, taskId, limit: 0, includeLogs: open },
    {
      enabled: Boolean(scope),
      refetchInterval: (data) =>
        running || (data?.snapshot.hasPending && data.snapshot.controls.day.state === 'running')
          ? 1000
          : false,
      cacheTime: 60_000,
      staleTime: 0,
      refetchOnMount: 'always',
    },
  );
  const value = query.data;
  const failure = error || query.error?.message;
  async function control(scope: 'month' | 'day', action: CalendarControlAction, day?: string) {
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      await client.account.calendarOverview.control.mutate({
        ...binding,
        id: value.id,
        scope,
        action,
        day,
      });
      await query.refetch();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="weq-calendar-task-details" data-privacy-sensitive>
      {failure ? <p role="alert">{failure}</p> : null}
      {value || !failure ? (
        <CalendarStatisticsProgress
          onControl={(scope, action, day) => void control(scope, action, day)}
          snapshot={value?.snapshot}
          busy={busy}
          statusText={!value ? '正在读取统计…' : undefined}
          logOpen={open}
          onLogOpenChange={setOpen}
        />
      ) : null}
    </div>
  );
}

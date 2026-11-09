import { useContext, useState } from 'react';
import type { CalendarAnchor, CalendarTarget } from '@weq/service/conversation-calendar';
import type { BackgroundTaskScope } from '../../../shared/background_task';
import { client, trpc } from '../trpc/client';
import { useCalendarKinds } from '../hooks/useCalendarKinds';
import { CalendarNavigationContext } from '../lib/calendarNavigation';
import { CalendarStatistics } from './CalendarStatistics';

const targets = new Map<string, CalendarTarget>();
export function CalendarTaskDetails({
  taskId,
  scope,
  running,
}: {
  taskId: string;
  scope: BackgroundTaskScope | null;
  running: boolean;
}) {
  const [day, setDay] = useState<string>();
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [kinds] = useCalendarKinds();
  const navigate = useContext(CalendarNavigationContext);
  const binding = { expectedAccountUin: scope?.uin, expectedAccountConfigId: scope?.configId };
  const query = trpc.account.calendarOverview.task.useQuery(
    { ...binding, taskId, day, kinds, limit, includeLogs: open },
    { enabled: Boolean(scope), refetchInterval: running ? 1000 : false, cacheTime: 0 },
  );
  const value = query.data;
  const selectedDay = day ?? value?.day ?? `${value?.month ?? ''}-01`;
  async function locate(target: CalendarTarget, anchor: CalendarAnchor) {
    if (!value || !navigate || busy) return;
    setBusy(true);
    try {
      const result = await client.account.calendarOverview.locate.mutate({
        ...binding,
        id: value.id,
        target,
        anchor,
      });
      navigate(result.target, result.anchor, result.record);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="weq-calendar-task-details" data-privacy-sensitive>
      <CalendarStatistics
        snapshot={value?.snapshot}
        day={selectedDay}
        month={value?.month}
        onDayChange={(day) => {
          setDay(day);
          setLimit(50);
        }}
        id={value?.id}
        targets={targets}
        busy={busy || !navigate}
        error={error || query.error?.message}
        logOpen={open}
        onLogOpenChange={setOpen}
        onLocate={(target, anchor) => void locate(target, anchor)}
        onLoadMore={() =>
          setLimit((current) => Math.min(current + 50, value?.snapshot.totalRows ?? current))
        }
      />
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Modal } from '../Dialog';
import { MessageCalendar } from '../MessageCalendar';
import { beijingDay, daySeconds, type MessageDay } from '../../lib/messageCalendar';
import { client } from '../../trpc/client';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import { useRecordContextMenu } from './useRecordContextMenu';

const DAY_SECONDS = 86400;

export function RecordSearchCalendar({
  kind,
  conv,
  binding,
  anchor,
  initialDay,
  localDays,
  start,
  end,
  onPick,
  onPickSingle,
  onLocate,
  onClear,
  onClose,
}: {
  kind: 'group' | 'c2c';
  conv: string;
  binding?: QQWriteBinding;
  anchor: HTMLElement | null;
  initialDay: string;
  localDays?: MessageDay[];
  start: string;
  end: string;
  onPick: (day: string) => void;
  onPickSingle: (day: string) => void;
  onLocate: (day: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const today = beijingDay();
  const [month, setMonth] = useState((start || initialDay || today).slice(0, 7));
  const [months, setMonths] = useState<Record<string, MessageDay[]>>({});
  const [partial, setPartial] = useState<{ month: string; days: MessageDay[] }>();
  const [error, setError] = useState<{ month: string; message: string }>();
  const [retry, setRetry] = useState(0);
  const cached = months[month];
  const expectedAccountUin = binding?.expectedAccountUin;
  const expectedAccountConfigId = binding?.expectedAccountConfigId;
  useEffect(() => {
    if (localDays || cached) return;
    const controller = new AbortController();
    const { signal } = controller;
    const first = daySeconds(`${month}-01`);
    const [year, monthNumber] = month.split('-').map(Number);
    const next = daySeconds(new Date(Date.UTC(year!, monthNumber!, 1)).toISOString().slice(0, 10));
    async function read() {
      const days: MessageDay[] = [];
      for (let cursor = first; cursor < next; cursor += 7 * DAY_SECONDS) {
        const batch = await client.account.conversationCalendar.query(
          {
            kind,
            conv,
            expectedAccountUin,
            expectedAccountConfigId,
            bounds: { start: cursor, end: Math.min(next, cursor + 7 * DAY_SECONDS) - 1 },
          },
          { signal },
        );
        if (signal.aborted) return;
        days.push(...batch);
        setPartial({ month, days: [...days] });
      }
      setMonths((previous) => ({ ...previous, [month]: days }));
    }
    void read().catch((failure) => {
      if (!signal.aborted) setError({ month, message: String(failure) });
    });
    return () => controller.abort();
  }, [month, cached, localDays, conv, kind, expectedAccountUin, expectedAccountConfigId, retry]);

  const loading = !localDays && !cached && error?.month !== month;
  const days = localDays ?? cached ?? (partial?.month === month ? partial.days : undefined);
  const dayStatus = useMemo(() => {
    const length = new Date(
      Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0),
    ).getUTCDate();
    return Object.fromEntries(
      Array.from({ length }, (_, i) => [
        `${month}-${String(i + 1).padStart(2, '0')}`,
        { complete: Boolean(cached || localDays) },
      ]),
    );
  }, [month, cached, localDays]);
  const locate = useRecordContextMenu('在搜索结果中定位到当日');
  return (
    <Modal
      presentation="popover"
      anchor={anchor}
      anchorPlacement="below"
      onClose={onClose}
      width={420}
      labelledBy="record-search-calendar-title"
    >
      <div className="weq-message-calendar">
        <header>
          <h3 id="record-search-calendar-title">日期</h3>
          {start ? (
            <button type="button" className="weq-set-btn" onClick={onClear}>
              清除日期
            </button>
          ) : null}
          <button type="button" className="weq-dialog-x" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <MessageCalendar
          month={month}
          onMonthChange={setMonth}
          days={days}
          dayStatus={dayStatus}
          start={start}
          end={end}
          maxDay={today}
          fixedWeekCount={false}
          allowEmpty
          loading={loading}
          error={error?.month === month ? error.message : undefined}
          statusText="选两个日期设置范围，双击选择当天"
          onPick={onPick}
          dayProps={(day) => ({
            ...locate.trigger<HTMLButtonElement>(() => onLocate(day)),
            onDoubleClick: () => onPickSingle(day),
          })}
        />
        {error?.month === month ? (
          <button
            type="button"
            className="weq-set-btn"
            onClick={() => {
              setError(undefined);
              setRetry((value) => value + 1);
            }}
          >
            重试
          </button>
        ) : null}
      </div>
      {locate.menu}
    </Modal>
  );
}

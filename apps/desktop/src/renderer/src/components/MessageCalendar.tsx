import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { beijingDay, messageDensity, type MessageDay } from '../lib/messageCalendar';
import '../styles/message-calendar.css';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const compactCount = Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });

export function MessageCalendar({
  days = [],
  start = '',
  end = '',
  onPick,
  allowEmpty = false,
  loading = false,
  busy = false,
  error,
  leading,
  trailing,
  month: controlledMonth,
  onMonthChange,
  dayStatus,
  yearOptions,
  statusText,
  maxDay,
}: {
  days?: readonly MessageDay[];
  start?: string;
  end?: string;
  onPick: (day: string) => void;
  allowEmpty?: boolean;
  loading?: boolean;
  busy?: boolean;
  error?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  month?: string;
  onMonthChange?: (month: string) => void;
  dayStatus?: Record<string, { complete: boolean; reason?: string; paused?: boolean }>;
  yearOptions?: string[];
  statusText?: string;
  maxDay?: string;
}) {
  const [localMonth, setLocalMonth] = useState((start || beijingDay()).slice(0, 7));
  const month = controlledMonth ?? localMonth;
  const setMonth = (value: string) => {
    setLocalMonth(value);
    onMonthChange?.(value);
  };
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || loading) return;
    if (!controlledMonth && !start && days.length) setLocalMonth(days.at(-1)!.day.slice(0, 7));
    initialized.current = true;
  }, [days, loading, start, controlledMonth]);
  const counts = useMemo(() => new Map(days.map((row) => [row.day, row.count])), [days]);
  const maxCount = useMemo(
    () =>
      days.reduce((max, row) => (!maxDay || row.day <= maxDay ? Math.max(max, row.count) : max), 0),
    [days, maxDay],
  );
  const [year = 2026, mon = 1] = month.split('-').map(Number);
  const leadingDays = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
  const length = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const years = [
    ...new Set([...(yearOptions ?? []), ...days.map((day) => day.day.slice(0, 4)), String(year)]),
  ].sort();
  function move(delta: number) {
    initialized.current = true;
    setMonth(new Date(Date.UTC(year, mon - 1 + delta, 1)).toISOString().slice(0, 7));
  }
  return (
    <div className="weq-density-calendar">
      <div className="weq-density-calendar-tools">
        {leading}
        <button type="button" title="上个月" aria-label="上个月" onClick={() => move(-1)}>
          <ChevronLeft size={16} />
        </button>
        <select
          aria-label="年份"
          value={year}
          onChange={(e) => {
            initialized.current = true;
            setMonth(e.target.value + month.slice(4));
          }}
        >
          {years.map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
        <select
          aria-label="月份"
          value={mon}
          onChange={(e) => {
            initialized.current = true;
            setMonth(`${year}-${e.target.value.padStart(2, '0')}`);
          }}
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((monthNumber) => (
            <option key={monthNumber} value={monthNumber}>
              {monthNumber}月
            </option>
          ))}
        </select>
        <button type="button" title="下个月" aria-label="下个月" onClick={() => move(1)}>
          <ChevronRight size={16} />
        </button>
        {trailing}
      </div>
      <div className="weq-density-calendar-grid" aria-busy={loading}>
        {WEEKDAYS.map((day) => (
          <span key={day} className="weq-density-weekday">
            {day}
          </span>
        ))}
        {Array.from({ length: 42 }, (_, index) => {
          const date = index - leadingDays + 1;
          const key = `${month}-${index}`;
          if (date < 1 || date > length) return <span key={key} />;
          const day = `${month}-${String(date).padStart(2, '0')}`;
          const future = Boolean(maxDay && day > maxDay);
          const reason = dayStatus?.[day]?.reason;
          const paused = dayStatus?.[day]?.paused;
          const count = counts.get(day) ?? 0;
          const pending = dayStatus ? !dayStatus[day]?.complete : loading && !counts.has(day);
          const selected = day === start || day === end;
          const inRange = Boolean(start && end && day >= start && day <= end);
          return (
            <button
              type="button"
              key={key}
              data-density={messageDensity(count, maxCount)}
              className={`${selected && !future ? 'is-selected' : ''} ${inRange && !future ? 'is-range' : ''} ${future ? 'is-future' : ''}`}
              aria-pressed={selected && !future}
              aria-label={
                future
                  ? `${day}，未来日期不统计`
                  : reason
                    ? `${day}，${reason}`
                    : paused
                      ? `${day}，统计已暂停`
                      : pending
                        ? count > 0
                          ? `${day}，已计 ${count} 条，尚未完成`
                          : `${day}，消息数量统计中`
                        : `${day}，${count} 条消息`
              }
              title={
                future
                  ? `${day}（北京时间）：未来日期不统计`
                  : reason
                    ? `${day}（北京时间）：${reason}`
                    : paused
                      ? `${day}（北京时间）：统计已暂停`
                      : pending
                        ? count > 0
                          ? `${day}（北京时间）：已计 ${count.toLocaleString('zh-CN')} 条，尚未完成`
                          : `${day}（北京时间）：消息数量统计中`
                        : `${day}（北京时间）：${count.toLocaleString('zh-CN')} 条`
              }
              disabled={future || busy || (!allowEmpty && (loading || !count))}
              onClick={() => {
                initialized.current = true;
                onPick(day);
              }}
            >
              <span>{date}</span>
              <small>
                {future || reason
                  ? ''
                  : pending
                    ? count > 0
                      ? `${compactCount.format(count)}+`
                      : paused
                        ? '暂停'
                        : '…'
                    : count
                      ? compactCount.format(count)
                      : dayStatus
                        ? '0'
                        : ''}
              </small>
            </button>
          );
        })}
      </div>
      <div className="weq-density-calendar-status" role="status">
        {statusText ??
          (loading
            ? '正在读取消息数量…'
            : `北京时间 · ${days.filter((day) => day.count > 0).length} 个有记录日期`)}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

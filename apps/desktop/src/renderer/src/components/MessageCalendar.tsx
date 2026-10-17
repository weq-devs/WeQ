import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { beijingDay, messageDensity, type MessageDay } from '../lib/messageCalendar';
import '../styles/message-calendar.css';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

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
}) {
  const [month, setMonth] = useState((start || beijingDay()).slice(0, 7));
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || loading) return;
    if (!start && days.length) setMonth(days.at(-1)!.day.slice(0, 7));
    initialized.current = true;
  }, [days, loading, start]);
  const counts = useMemo(() => new Map(days.map((row) => [row.day, row.count])), [days]);
  const maxCount = useMemo(() => days.reduce((max, row) => Math.max(max, row.count), 0), [days]);
  const [year = 2026, mon = 1] = month.split('-').map(Number);
  const leadingDays = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
  const length = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const years = [...new Set([...days.map((day) => day.day.slice(0, 4)), String(year)])].sort();
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
          onChange={(e) => setMonth(e.target.value + month.slice(4))}
        >
          {years.map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
        <select
          aria-label="月份"
          value={mon}
          onChange={(e) => setMonth(`${year}-${e.target.value.padStart(2, '0')}`)}
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
          const count = counts.get(day) ?? 0;
          const selected = day === start || day === end;
          const inRange = Boolean(start && end && day >= start && day <= end);
          return (
            <button
              type="button"
              key={key}
              data-density={messageDensity(count, maxCount)}
              className={`${selected ? 'is-selected' : ''} ${inRange ? 'is-range' : ''}`}
              aria-pressed={selected}
              aria-label={`${day}，${count} 条消息`}
              title={`${day}（北京时间）：${count.toLocaleString('zh-CN')} 条`}
              disabled={busy || loading || (!allowEmpty && !count)}
              onClick={() => onPick(day)}
            >
              <span>{date}</span>
              <small>
                {count
                  ? Intl.NumberFormat('zh-CN', {
                      notation: 'compact',
                      maximumFractionDigits: 1,
                    }).format(count)
                  : ''}
              </small>
            </button>
          );
        })}
      </div>
      <div className="weq-density-calendar-status" role="status">
        {loading ? '正在读取消息数量…' : `北京时间 · ${days.length} 个有记录日期`}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

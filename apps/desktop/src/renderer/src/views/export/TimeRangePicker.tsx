/**
 * 时间范围选择器：上方预设快捷（全部 / 今天 / 近 7 天 / 近 30 天 / 近一年 /
 * 自定义），自定义时展开一个月历，点选起止两端形成区间。
 *
 * 区间以 unix 秒存储：start = 当天 00:00:00，end = 当天 23:59:59。preset 为
 * 'all' 时两端都为 null（不限）。月历自带上/下月切换，选中端点高亮、区间淡染。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { RangePreset, TimeRange } from './types';

const PRESETS: Array<{ value: RangePreset; label: string }> = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: '1y', label: '近一年' },
  { value: 'custom', label: '自定义' },
];

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function startOfDay(d: Date): number {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  return Math.floor(x.getTime() / 1000);
}
function endOfDay(d: Date): number {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return Math.floor(x.getTime() / 1000);
}

/** Resolve a preset to a concrete range (custom is left to the caller). */
function rangeForPreset(preset: RangePreset): TimeRange {
  const now = new Date();
  if (preset === 'all') return { preset, start: null, end: null };
  if (preset === 'today') return { preset, start: startOfDay(now), end: endOfDay(now) };
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 365;
  const from = new Date(now);
  from.setDate(from.getDate() - (days - 1));
  return { preset, start: startOfDay(from), end: endOfDay(now) };
}

/** Hint per preset. `single` (the default) describes the static window the
 *  user is exporting right now. `scheduled` describes how the window rolls
 *  forward on each fire — important so "近 7 天" doesn't read as "the 7
 *  days I picked this preset". */
const PRESET_HINTS: Record<RangePreset, { single: string; scheduled: string }> = {
  all: { single: '不限制时间', scheduled: '每次触发都导出全量消息' },
  today: { single: '今天的 00:00 ~ 23:59', scheduled: '每次触发 = 当天 00:00 ~ 23:59（按触发日滚动）' },
  '7d': { single: '今天往前 7 天（含今天）', scheduled: '每次触发 = 触发日往前 7 天（窗口会滚动）' },
  '30d': { single: '今天往前 30 天（含今天）', scheduled: '每次触发 = 触发日往前 30 天（窗口会滚动）' },
  '1y': { single: '今天往前 365 天（含今天）', scheduled: '每次触发 = 触发日往前 365 天（窗口会滚动）' },
  custom: { single: '月历里点选的具体起止日', scheduled: '起止日是固定的，每次触发都按相同区间导出' },
};

function fmtDay(secs: number | null): string {
  if (secs == null) return '不限';
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function TimeRangePicker({
  value,
  onChange,
  mode = 'single',
}: {
  value: TimeRange;
  onChange: (next: TimeRange) => void;
  /** 'single' = a one-shot export. 'scheduled' = a template that fires
   *  repeatedly; preset windows are re-resolved at fire-time. Drives the
   *  hint copy and the per-preset `title`. */
  mode?: 'single' | 'scheduled';
}): ReactElement {
  // The month the calendar is currently showing.
  const initial = value.start ? new Date(value.start * 1000) : new Date();
  const [viewY, setViewY] = useState(initial.getFullYear());
  const [viewM, setViewM] = useState(initial.getMonth());

  const weeks = useMemo(() => buildMonth(viewY, viewM), [viewY, viewM]);

  function pickPreset(preset: RangePreset): void {
    if (preset === 'custom') {
      // Keep whatever concrete dates exist; default to today if none.
      const today = startOfDay(new Date());
      onChange({ preset, start: value.start ?? today, end: value.end ?? endOfDay(new Date()) });
    } else {
      onChange(rangeForPreset(preset));
    }
  }

  function pickDay(dayStart: number): void {
    const dayEnd = endOfDay(new Date(dayStart * 1000));
    // No start, or a complete range already chosen → begin a fresh range.
    if (value.start == null || (value.start != null && value.end != null)) {
      onChange({ preset: 'custom', start: dayStart, end: null });
      return;
    }
    // Second click closes the range (swap if the user went backwards).
    if (dayStart < value.start) {
      onChange({ preset: 'custom', start: dayStart, end: endOfDay(new Date(value.start * 1000)) });
    } else {
      onChange({ preset: 'custom', start: value.start, end: dayEnd });
    }
  }

  function shiftMonth(delta: number): void {
    let m = viewM + delta;
    let y = viewY;
    if (m < 0) {
      m = 11;
      y -= 1;
    } else if (m > 11) {
      m = 0;
      y += 1;
    }
    setViewM(m);
    setViewY(y);
  }

  const isCustom = value.preset === 'custom';

  return (
    <div className="weq-exp-range">
      {mode === 'scheduled' ? (
        <p className="weq-exp-range-note">
          预设窗口（今天 / 近 N 天）会在每次触发时按当时时间重新计算。
          <br />
          「自定义」是固定区间，不会滚动。
        </p>
      ) : null}
      <div className="weq-exp-range-presets">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            className={`weq-exp-chip${value.preset === p.value ? ' is-on' : ''}`}
            onClick={() => pickPreset(p.value)}
            title={PRESET_HINTS[p.value][mode]}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="weq-exp-range-summary">
        <span>{fmtDay(value.start)}</span>
        <span className="weq-exp-range-arrow">→</span>
        <span>{fmtDay(value.end)}</span>
      </div>

      {isCustom ? (
        <div className="weq-exp-cal">
          <div className="weq-exp-cal-head">
            <button type="button" onClick={() => shiftMonth(-1)} title="上个月">
              <ChevronLeft size={16} />
            </button>
            <span className="weq-exp-cal-title">
              {viewY} 年 {viewM + 1} 月
            </span>
            <button type="button" onClick={() => shiftMonth(1)} title="下个月">
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="weq-exp-cal-grid">
            {WEEKDAYS.map((w) => (
              <span key={w} className="weq-exp-cal-wd">
                {w}
              </span>
            ))}
            {weeks.map((cell, i) => {
              if (cell == null) return <span key={`blank-${i}`} className="weq-exp-cal-cell is-blank" />;
              const dayStart = cell.start;
              const inRange =
                value.start != null &&
                value.end != null &&
                dayStart >= value.start &&
                dayStart <= value.end;
              const isEnd = dayStart === value.start || dayStart === startOfDay(new Date((value.end ?? 0) * 1000));
              return (
                <button
                  key={dayStart}
                  type="button"
                  className={`weq-exp-cal-cell${inRange ? ' is-range' : ''}${isEnd ? ' is-end' : ''}${
                    cell.today ? ' is-today' : ''
                  }`}
                  onClick={() => pickDay(dayStart)}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
          <p className="weq-exp-cal-hint">
            点选两次：第一次为起始日，第二次为结束日。
            {mode === 'scheduled' ? '（起止日固定，每次触发都按相同区间导出）' : ''}
          </p>
        </div>
      ) : null}
    </div>
  );
}

interface DayCell {
  day: number;
  start: number;
  today: boolean;
}

/** Build a month as a flat array of cells (null = leading/trailing blank). */
function buildMonth(year: number, month: number): Array<DayCell | null> {
  const first = new Date(year, month, 1);
  const leading = first.getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStart = startOfDay(new Date());

  const cells: Array<DayCell | null> = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    const start = startOfDay(new Date(year, month, d));
    cells.push({ day: d, start, today: start === todayStart });
  }
  // Pad to a whole number of weeks for a stable grid height.
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

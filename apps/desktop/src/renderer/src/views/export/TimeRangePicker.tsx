/**
 * 时间范围选择器：预设快捷（全部 / 今天 / 近 7 天 / 近 30 天 / 近一年 / 自定义）
 * + 常驻的精简月历。点选预设后，对应区间直接在月历上高亮；点选日期会切到
 * 「自定义」并形成起止两端。
 *
 * 区间以 unix 秒存储：start = 当天 00:00:00，end = 当天 23:59:59。preset 为
 * 'all' 时两端都为 null（不限）。月历自带上/下月切换，选中端点高亮、区间淡染。
 */

import type { ReactElement } from 'react';
import type { RangePreset, TimeRange } from './types';
import { MessageCalendar } from '../../components/MessageCalendar';
import {
  beijingDay,
  daySeconds,
  pickCalendarRange,
  type CalendarTarget,
} from '../../lib/messageCalendar';
import { trpc } from '../../trpc/client';

const PRESETS: Array<{ value: RangePreset; label: string }> = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: '1y', label: '近一年' },
  { value: 'custom', label: '自定义' },
];

function startOfDay(d: Date): number {
  return daySeconds(beijingDay(d));
}
function endOfDay(d: Date): number {
  return startOfDay(d) + 86399;
}

/** Resolve a preset to a concrete range (custom is left to the caller). */
function rangeForPreset(preset: RangePreset): TimeRange {
  const now = new Date();
  if (preset === 'all') return { preset, start: null, end: null };
  if (preset === 'today') return { preset, start: startOfDay(now), end: endOfDay(now) };
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 365;
  return { preset, start: startOfDay(now) - (days - 1) * 86400, end: endOfDay(now) };
}

/** Hint per preset. `single` (the default) describes the static window the
 *  user is exporting right now. `scheduled` describes how the window rolls
 *  forward on each fire — important so "近 7 天" doesn't read as "the 7
 *  days I picked this preset". */
const PRESET_HINTS: Record<RangePreset, { single: string; scheduled: string }> = {
  all: { single: '不限制时间', scheduled: '每次触发都导出全量消息' },
  today: {
    single: '今天的 00:00 ~ 23:59',
    scheduled: '每次触发 = 当天 00:00 ~ 23:59（按触发日滚动）',
  },
  '7d': {
    single: '今天往前 7 天（含今天）',
    scheduled: '每次触发 = 触发日往前 7 天（窗口会滚动）',
  },
  '30d': {
    single: '今天往前 30 天（含今天）',
    scheduled: '每次触发 = 触发日往前 30 天（窗口会滚动）',
  },
  '1y': {
    single: '今天往前 365 天（含今天）',
    scheduled: '每次触发 = 触发日往前 365 天（窗口会滚动）',
  },
  custom: {
    single: '月历里点选的具体起止日',
    scheduled: '起止日是固定的，每次触发都按相同区间导出',
  },
};

function fmtDay(secs: number | null): string {
  if (secs == null) return '不限';
  return beijingDay(new Date(secs * 1000));
}

export function TimeRangePicker({
  value,
  onChange,
  mode = 'single',
  calendarTargets = [],
}: {
  value: TimeRange;
  onChange: (next: TimeRange) => void;
  /** 'single' = a one-shot export. 'scheduled' = a template that fires
   *  repeatedly; preset windows are re-resolved at fire-time. Drives the
   *  hint copy and the per-preset `title`. */
  mode?: 'single' | 'scheduled';
  calendarTargets?: CalendarTarget[];
}): ReactElement {
  const calendar = trpc.account.exportCalendar.useQuery(
    { targets: calendarTargets },
    {
      enabled: calendarTargets.length > 0,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );

  function pickPreset(preset: RangePreset): void {
    if (preset === 'custom') {
      // Keep whatever concrete dates exist; default to today if none.
      const today = startOfDay(new Date());
      onChange({ preset, start: value.start ?? today, end: value.end ?? endOfDay(new Date()) });
    } else {
      onChange(rangeForPreset(preset));
    }
  }

  function pickDay(day: string): void {
    const range = pickCalendarRange(
      value.start == null ? '' : fmtDay(value.start),
      value.end == null ? '' : fmtDay(value.end),
      day,
    );
    onChange({
      preset: 'custom',
      start: daySeconds(range.start),
      end: range.end ? daySeconds(range.end) + 86399 : null,
    });
  }

  /** 回到「全部时间」。 */
  function resetAll(): void {
    onChange({ preset: 'all', start: null, end: null });
  }

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
        <span className="weq-exp-range-summary-main">
          <span>{fmtDay(value.start)}</span>
          <span className="weq-exp-range-arrow">→</span>
          <span>{fmtDay(value.end)}</span>
        </span>
        {value.preset !== 'all' ? (
          <button type="button" className="weq-exp-range-clear" onClick={resetAll}>
            不限
          </button>
        ) : (
          <span className="weq-exp-range-tag">全部时间</span>
        )}
      </div>

      <MessageCalendar
        days={calendar.data}
        start={value.start == null ? '' : fmtDay(value.start)}
        end={value.end == null ? '' : fmtDay(value.end)}
        allowEmpty
        onPick={pickDay}
        loading={calendarTargets.length > 0 && calendar.isLoading}
        error={calendar.error?.message}
      />
    </div>
  );
}

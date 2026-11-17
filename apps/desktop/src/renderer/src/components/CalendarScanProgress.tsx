import { NumericText } from './NumericText';
import { Pause, Play, RefreshCw } from 'lucide-react';
import { TaskProgressBar } from './tasks/TaskProgressBar';
import { beijingDay } from '../lib/messageCalendar';
import type {
  CalendarControlAction,
  CalendarControlState,
} from '@weq/service/conversation-calendar';

export function CalendarScanProgress({
  days,
  controls,
  busy = false,
  onControl,
}: {
  days?: readonly {
    day: string;
    complete: boolean;
    errors: readonly string[];
    unavailable?: boolean;
  }[];
  controls?: {
    month: { state: CalendarControlState; disabled: boolean };
    day: { state: CalendarControlState; disabled: boolean };
  };
  busy?: boolean;
  onControl?: (scope: 'month' | 'day', action: CalendarControlAction, day?: string) => void;
}) {
  const state = controls?.month;
  const available = days?.filter((day) => !day.unavailable && day.day <= beijingDay());
  const total = available?.length ?? 0;
  const completed = available?.filter((day) => day.complete && !day.errors.length).length ?? 0;
  const empty = state?.state === 'empty' || (days !== undefined && total === 0);
  const action =
    state?.state === 'running' ? 'pause' : state?.state === 'paused' ? 'continue' : 'retry';
  const name = `${{ pause: '暂停', continue: '继续', retry: '重试' }[action]}当月统计`;
  const Icon = action === 'pause' ? Pause : action === 'continue' ? Play : RefreshCw;
  return (
    <div className="weq-overview-calendar-progress" role="group" aria-label="统计进度">
      <section>
        <div>
          <span>当月进度</span>
          <strong>
            {empty ? (
              '未开始'
            ) : days ? (
              <NumericText>{`${completed} / ${total} 天`}</NumericText>
            ) : (
              '准备中'
            )}
          </strong>
        </div>
        <div className="weq-calendar-progress-track">
          <TaskProgressBar
            label="当月进度"
            status={empty ? 'pending' : (state?.state ?? 'running')}
            valueText={
              empty ? '暂无可统计日期' : days ? `已完成 ${completed} / ${total} 天统计` : '准备中'
            }
            value={empty ? 0 : days ? (completed / Math.max(1, total)) * 100 : undefined}
          />
          {onControl ? (
            <button
              type="button"
              className="weq-calendar-progress-control"
              title={empty ? '暂无可统计日期' : name}
              aria-label={name}
              disabled={busy || !state || state.disabled}
              onClick={() => onControl('month', action)}
            >
              <Icon size={14} aria-hidden />
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

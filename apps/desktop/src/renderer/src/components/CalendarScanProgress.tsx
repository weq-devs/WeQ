import { Pause, Play, RotateCw } from 'lucide-react';
import type {
  CalendarControlAction,
  CalendarControlState,
} from '@weq/service/conversation-calendar';

export interface CalendarSourceProgress {
  completedSources: number;
  totalSources: number;
}
export function CalendarScanProgress({
  progress,
  dayProgress,
  day,
  controls,
  busy = false,
  onControl,
}: {
  progress?: CalendarSourceProgress;
  dayProgress?: CalendarSourceProgress;
  day: string;
  controls?: {
    month: { state: CalendarControlState; disabled: boolean };
    day: { state: CalendarControlState; disabled: boolean };
  };
  busy?: boolean;
  onControl?: (scope: 'month' | 'day', action: CalendarControlAction, day?: string) => void;
}) {
  return (
    <div className="weq-overview-calendar-progress" role="group" aria-label="统计进度">
      {[
        { scope: 'month' as const, label: '当月进度', value: progress },
        { scope: 'day' as const, label: `${day} 进度`, value: dayProgress },
      ].map(({ scope, label, value }) => {
        const state = controls?.[scope];
        const empty = state?.state === 'empty' || value?.totalSources === 0;
        const action =
          state?.state === 'running' ? 'pause' : state?.state === 'paused' ? 'continue' : 'retry';
        const name = `${{ pause: '暂停', continue: '继续', retry: '重试' }[action]}${scope === 'month' ? '当月' : day}统计`;
        const Icon = action === 'pause' ? Pause : action === 'continue' ? Play : RotateCw;
        return (
          <section key={label}>
            <div>
              <span>{label}</span>
              <strong>
                {empty
                  ? '未开始'
                  : value
                    ? `${value.completedSources} / ${value.totalSources}`
                    : '准备中'}
              </strong>
            </div>
            <div className="weq-calendar-progress-track">
              <progress
                aria-label={label}
                aria-valuetext={
                  empty
                    ? '暂无可统计来源'
                    : value
                      ? `已完成 ${value.completedSources} / ${value.totalSources} 个来源统计`
                      : '准备中'
                }
                max={Math.max(1, value?.totalSources ?? 1)}
                value={empty ? 0 : value?.completedSources}
              />
              {onControl ? (
                <button
                  type="button"
                  className="weq-calendar-progress-control"
                  title={empty ? '暂无可统计来源' : name}
                  aria-label={name}
                  disabled={busy || !state || state.disabled}
                  onClick={() => onControl(scope, action, scope === 'day' ? day : undefined)}
                >
                  <Icon size={14} aria-hidden />
                </button>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

import {
  CALENDAR_SOURCE_LABELS,
  type CalendarControlAction,
} from '@weq/service/conversation-calendar';
import { NumericText } from './NumericText';
import { CalendarScanProgress } from './CalendarScanProgress';
import { calendarReadLabel } from './CalendarStatistics.shared';
import type { CalendarSnapshot } from './CalendarStatistics';
import { TaskLogDisclosure } from './TaskLogDisclosure';

export function CalendarStatisticsProgress({
  snapshot,
  busy,
  statusText,
  logOpen,
  onLogOpenChange,
  onControl,
}: {
  snapshot?: CalendarSnapshot;
  busy: boolean;
  statusText?: string;
  logOpen: boolean;
  onLogOpenChange: (open: boolean) => void;
  onControl?: (scope: 'month' | 'day', action: CalendarControlAction, day?: string) => void;
}) {
  return (
    <section className="weq-calendar-statistics-progress" aria-label="统计状态与日志">
      <h4>统计进度</h4>
      <CalendarScanProgress
        days={snapshot?.days}
        controls={snapshot?.controls}
        busy={busy}
        onControl={onControl}
      />
      <p className="weq-calendar-read-status" role="status">
        {statusText ?? calendarReadLabel(snapshot) ?? '当月消息数量统计完成'}
      </p>
      <p className="weq-overview-calendar-scan-label">
        {snapshot?.activeScan ? (
          <>
            <span className="weq-number weq-number-inherit">{snapshot.activeScan.day}</span> ·{' '}
            {CALENDAR_SOURCE_LABELS[snapshot.activeScan.kind]}
            {snapshot.activeScan.progress ? (
              <NumericText>{` · ${snapshot.activeScan.progress.phase} · 已处理 ${snapshot.activeScan.progress.processed.toLocaleString('zh-CN')} ${snapshot.activeScan.progress.unit}`}</NumericText>
            ) : null}
          </>
        ) : null}
      </p>
      <TaskLogDisclosure
        open={logOpen}
        onOpenChange={onLogOpenChange}
        lines={snapshot?.logs ?? []}
        scrollable
      />
      {[
        ...new Set(
          [
            snapshot?.persistenceError,
            ...(snapshot?.days.flatMap((item) => item.errors) ?? []),
          ].filter(Boolean),
        ),
      ].map((message) => (
        <p role="alert" key={message}>
          {message}
        </p>
      ))}
    </section>
  );
}

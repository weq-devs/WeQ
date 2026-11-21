import type { ReactNode } from 'react';
import { NumericText } from './NumericText';
import type { CalendarTarget, CalendarAnchor } from '@weq/service/conversation-calendar';
import { CalendarConversationList } from './CalendarConversationList';
import type { CalendarSnapshot } from './CalendarStatistics.shared';

export function CalendarStatistics({
  children,
  snapshot,
  day,
  id,
  targets,
  busy,
  error,
  onLocate,
  onLoadMore,
}: {
  children?: ReactNode;
  snapshot?: CalendarSnapshot;
  day: string;
  id?: string;
  targets: Map<string, CalendarTarget>;
  busy: boolean;
  error?: string;
  onLocate: (target: CalendarTarget, anchor: CalendarAnchor) => void;
  onLoadMore: () => void;
}) {
  return (
    <section className="weq-overview-calendar-conversations" aria-label="当天会话">
      {children}
      <h4 className="weq-calendar-list-date">{day}</h4>
      <p role="status">
        {error ??
          snapshot?.emptyReason ??
          (snapshot?.dayProgress ? (
            <>
              <NumericText>{`${snapshot.totalRows}${snapshot.complete ? '' : '+'} 个会话`}</NumericText>{' '}
              · 已计{' '}
              <span className="weq-number weq-number-inherit">
                {snapshot.dayProgress.count.toLocaleString('zh-CN')}
              </span>{' '}
              条{snapshot.dayProgress.paused ? ' · 该日已暂停' : ''}
            </>
          ) : snapshot?.complete ? (
            <NumericText>{`${snapshot.totalRows} 个会话`}</NumericText>
          ) : (
            '正在统计当天会话…'
          ))}
      </p>
      <CalendarConversationList
        key={`${id}:${day}`}
        rows={snapshot?.rows ?? []}
        total={snapshot?.totalRows ?? 0}
        complete={Boolean(snapshot?.complete || snapshot?.emptyReason)}
        busy={busy}
        showEmpty={!error && snapshot?.enabledKinds?.length !== 0 && !snapshot?.emptyReason}
        targets={targets}
        onLocate={onLocate}
        onLoadMore={onLoadMore}
      />
    </section>
  );
}
export type { CalendarSnapshot } from './CalendarStatistics.shared';

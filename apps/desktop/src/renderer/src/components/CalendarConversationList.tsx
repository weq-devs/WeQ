import { useCallback, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  CALENDAR_SOURCE_LABELS,
  calendarTargetKey,
  type CalendarAnchor,
  type CalendarTarget,
  type ConversationCalendarJob,
} from '@weq/service/conversation-calendar';

type Rows = ReturnType<ConversationCalendarJob['snapshot']>['rows'];
export function CalendarConversationList({
  rows,
  total,
  complete,
  busy,
  showEmpty,
  targets,
  onLocate,
  onLoadMore,
}: {
  rows: Rows;
  total: number;
  complete: boolean;
  busy: boolean;
  showEmpty: boolean;
  targets: Map<string, CalendarTarget>;
  onLocate: (target: CalendarTarget, anchor: CalendarAnchor) => void;
  onLoadMore: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const list = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 66,
    overscan: 5,
    getItemKey: (index) => calendarTargetKey(rows[index]!.target),
  });
  const maybeLoad = useCallback(() => {
    const node = viewport.current;
    if (node && rows.length < total && node.scrollHeight - node.scrollTop - node.clientHeight < 198)
      onLoadMore();
  }, [rows.length, total, onLoadMore]);
  useEffect(maybeLoad, [maybeLoad]);
  return (
    <div
      ref={viewport}
      className="weq-overview-calendar-rows"
      aria-label="当天会话列表"
      aria-busy={!complete}
      onScroll={maybeLoad}
      tabIndex={0}
    >
      <div style={{ height: list.getTotalSize(), position: 'relative' }}>
        {list.getVirtualItems().map((item) => {
          const stored = rows[item.index]!;
          const target = targets.get(calendarTargetKey(stored.target)) ?? stored.target;
          return (
            <button
              key={item.key}
              type="button"
              className="weq-overview-calendar-row"
              style={{ position: 'absolute', top: 0, transform: `translateY(${item.start}px)` }}
              disabled={busy}
              onClick={() => onLocate(target, stored.anchor)}
            >
              {target.avatar ? (
                <img src={target.avatar} alt="" />
              ) : (
                <span className="weq-overview-calendar-avatar" aria-hidden>
                  {Array.from(target.name)[0]}
                </span>
              )}
              <span className="weq-overview-calendar-name">
                <strong title={target.name}>{target.name}</strong>
                <small>{CALENDAR_SOURCE_LABELS[target.kind]}</small>
              </span>
              <span title={`${stored.count.toLocaleString('zh-CN')} 条`}>
                {stored.count.toLocaleString('zh-CN')}
                {complete ? '' : '+'}
              </span>
            </button>
          );
        })}
      </div>
      {rows.length < total ? <p role="status">正在加载更多会话…</p> : null}
      {showEmpty && complete && !rows.length ? <p>当天没有消息</p> : null}
    </div>
  );
}

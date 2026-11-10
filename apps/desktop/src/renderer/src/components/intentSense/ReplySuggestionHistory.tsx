import { useLayoutEffect, useRef } from 'react';
import { Lightbulb, RefreshCw } from 'lucide-react';
import type { ReplySuggestionHistoryEntry } from '@weq/service';

const timestamp = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function ReplySuggestionHistory({
  history,
  currentRoundId,
  onDetails,
  onInsert,
  onLocate,
}: {
  history: {
    data?: ReplySuggestionHistoryEntry[];
    isLoading: boolean;
    isFetching: boolean;
    error: { message: string } | null;
    refetch: () => unknown;
  };
  currentRoundId?: string;
  onDetails: (id: string, anchor: HTMLButtonElement) => void;
  onInsert: (text: string) => void;
  onLocate?: (target: ReplySuggestionHistoryEntry['target']) => void | Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    const pane = scroll?.closest<HTMLElement>('.chat-pane');
    if (!pane || !content || !scroll) return;
    const measure = () => {
      pane.style.setProperty(
        '--weq-int-history-content-height',
        `${content.getBoundingClientRect().height + 1}px`,
      );
      pane.style.setProperty(
        '--weq-int-history-scrollbar-width',
        `${scroll.offsetWidth - scroll.clientWidth}px`,
      );
      scroll.scrollTop = scroll.scrollHeight;
    };
    measure();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(content);
    observer.observe(scroll);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      pane.style.removeProperty('--weq-int-history-content-height');
      pane.style.removeProperty('--weq-int-history-scrollbar-width');
    };
  }, []);
  // 同样的文字可能属于不同轮次，只按正式栏持有的轮次 ID 去重。
  const entries = (history.data ?? []).filter((entry) => entry.id !== currentRoundId).toReversed();
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [history.data, currentRoundId]);
  return (
    <div
      className="weq-int-history"
      ref={scrollRef}
      role="region"
      aria-label="推荐回复历史"
      aria-busy={history.isFetching}
    >
      <div ref={contentRef}>
        {history.error ? (
          <div className="weq-int-history-state" role="alert">
            <span>回复历史读取失败：{history.error.message}</span>
            <button
              type="button"
              className="weq-int-suggest-refresh"
              title="重试读取历史"
              aria-label="重试读取回复历史"
              disabled={history.isFetching}
              onClick={() => void history.refetch()}
            >
              <RefreshCw size={13} />
            </button>
          </div>
        ) : null}
        {!entries.length ? (
          <div className="weq-int-history-state" role="status">
            {history.isLoading ? '正在读取回复历史…' : history.error ? null : '暂无推荐回复历史'}
          </div>
        ) : (
          entries.map((entry) => (
            <div className="weq-int-history-row" key={entry.id}>
              <button
                type="button"
                className="weq-int-suggest-refresh weq-int-suggest-locate"
                title={`定位到本次推荐的最后一条输入消息 · ${timestamp.format(entry.target.sendTime * 1000)}`}
                aria-label="定位到本次推荐的最后一条输入消息"
                disabled={!onLocate}
                onClick={() => void onLocate?.(entry.target)}
              >
                <Lightbulb size={12} className="weq-int-suggest-icon" aria-hidden />
              </button>
              <div className="weq-int-history-replies">
                {entry.suggestions.map((suggestion) => (
                  <button
                    key={`${suggestion.tone ?? ''}:${suggestion.text}`}
                    type="button"
                    className="weq-int-suggest-pill"
                    title={suggestion.text}
                    onClick={() => onInsert(suggestion.text)}
                  >
                    {suggestion.tone ? (
                      <span className="weq-int-suggest-tone">{suggestion.tone}</span>
                    ) : null}
                    <span className="weq-int-suggest-text">{suggestion.text}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="weq-int-history-date"
                title="查看本轮推荐详情"
                aria-label="查看本轮推荐详情"
                onClick={(event) => onDetails(entry.id, event.currentTarget)}
              >
                <time dateTime={new Date(entry.createdAt).toISOString()}>
                  {timestamp.format(entry.createdAt)}
                </time>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

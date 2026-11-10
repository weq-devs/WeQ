import { useLayoutEffect, useRef } from 'react';
import { LocateFixed, RefreshCw } from 'lucide-react';
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
  currentSuggestions,
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
  currentSuggestions: ReplySuggestionHistoryEntry['suggestions'];
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
      scroll.scrollTop = scroll.scrollHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => {
      observer.disconnect();
      pane.style.removeProperty('--weq-int-history-content-height');
    };
  }, []);
  // 服务按新到旧返回；只去掉仍在正式栏显示的最新一轮，不删除其他重复轮次。
  const entries = (history.data ?? [])
    .filter(
      (entry, index) =>
        index !== 0 ||
        !(
          entry.suggestions.length === currentSuggestions.length &&
          entry.suggestions.every(
            (item, i) =>
              item.text === currentSuggestions[i]?.text &&
              item.tone === currentSuggestions[i]?.tone,
          )
        ),
    )
    .toReversed();
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [history.data, currentSuggestions]);
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
                className="weq-int-suggest-refresh"
                title={`定位到本次推荐的最后一条输入消息 · ${timestamp.format(entry.target.sendTime * 1000)}`}
                aria-label="定位到本次推荐的最后一条输入消息"
                disabled={!onLocate}
                onClick={() => void onLocate?.(entry.target)}
              >
                <LocateFixed size={13} />
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
              <time dateTime={new Date(entry.createdAt).toISOString()}>
                {timestamp.format(entry.createdAt)}
              </time>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

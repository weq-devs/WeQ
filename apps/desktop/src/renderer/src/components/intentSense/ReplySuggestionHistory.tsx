import { useEffect, useRef } from 'react';
import { LocateFixed, RefreshCw } from 'lucide-react';
import { trpc } from '../../trpc/client';
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
  kind,
  conv,
  revision,
  onInsert,
  onLocate,
}: {
  kind: 'c2c' | 'group';
  conv: string;
  revision: unknown;
  onInsert: (text: string) => void;
  onLocate?: (target: ReplySuggestionHistoryEntry['target']) => void | Promise<void>;
}) {
  const history = trpc.account.intentSense.getSuggestionHistory.useQuery(
    { kind, conv },
    {
      refetchOnWindowFocus: false,
      staleTime: 0,
      cacheTime: 0,
      retry: false,
    },
  );
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current === revision) return;
    previousRevision.current = revision;
    void history.refetch();
  }, [revision, history.refetch]);
  return (
    <div
      className="weq-int-history"
      role="region"
      aria-label="推荐回复历史"
      aria-busy={history.isFetching}
    >
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
      {!history.data?.length ? (
        <div className="weq-int-history-state" role="status">
          {history.isLoading ? '正在读取回复历史…' : history.error ? null : '暂无推荐回复历史'}
        </div>
      ) : (
        history.data.map((entry) => (
          <div className="weq-int-history-row" key={entry.id}>
            <button
              type="button"
              className="weq-int-suggest-refresh"
              title={`定位到本次推荐的最后一条输入消息 · ${timestamp.format(entry.target.sendTime * 1000)}`}
              aria-label="定位到本次推荐的最后一条输入消息"
              disabled={!onLocate || !entry.target.msgSeq}
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
  );
}

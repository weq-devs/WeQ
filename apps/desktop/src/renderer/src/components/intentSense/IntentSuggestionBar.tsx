/**
 * 回复建议条 —— composer 上方的一行候选回复 pills。
 *
 * 回复建议独立开启；API 不依赖意图感知引擎，本地只提供规则候选兜底。
 * 点击一条把文本填进 composer 草稿（onInsert）。手动换一批绕过候选缓存，
 * 不受自己发送后的自动推荐开关限制，等待期间仍保留原候选。
 */

import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { Lightbulb, RefreshCw, ChevronUp, ChevronDown } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useToast } from '../Toast';
import { useIntentSenseStatus } from './context';
import { ReplySuggestionHistory } from './ReplySuggestionHistory';
import type { ReplySuggestionHistoryEntry } from '@weq/service';
import '../../styles/intent-sense.css';

interface SuggestionWire {
  text: string;
  tone?: string;
}

export function IntentSuggestionBar({
  kind,
  conv,
  replyTargetId,
  latestMessageId,
  onInsert,
  onLocate,
}: {
  kind: 'c2c' | 'group';
  conv: string;
  /** 明确为空时，仅在自己发言后推荐已开启且消息已发送时查询。 */
  replyTargetId?: string | null;
  latestMessageId?: string | null;
  onInsert: (text: string) => void;
  onLocate?: (target: ReplySuggestionHistoryEntry['target']) => void | Promise<void>;
}): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [historyScope, setHistoryScope] = useState<string | null>(null);
  const historyId = useId();
  const [refreshError, setRefreshError] = useState<{ context: string; message: string } | null>(
    null,
  );
  const status = useIntentSenseStatus();
  const replyAllowed =
    replyTargetId !== null || (status.data?.suggestAfterSelf === true && !!latestMessageId);
  const overridden = status.data?.conversationOverrides?.[`${kind}:${conv}`];
  const active = overridden !== false && !!status.data?.suggestionsEnabled;
  const suggestions = trpc.account.intentSense.getSuggestions.useQuery(
    {
      kind,
      conv,
      revision: status.data?.suggestionRevision ?? 0,
      replyAllowed,
      ...(latestMessageId !== undefined ? { targetId: latestMessageId } : {}),
    },
    {
      enabled: active && replyAllowed,
      refetchOnWindowFocus: false,
      staleTime: (status.data?.suggestionCacheSeconds ?? 90) * 1000,
      cacheTime: 0,
      retry: false,
    },
  );

  const scope = JSON.stringify([kind, conv, status.data?.suggestionRevision ?? 0, active]);
  const historyOpen = historyScope === scope;
  const requestContext = useRef('');
  requestContext.current = JSON.stringify([scope, latestMessageId, replyTargetId]);
  const refreshPending = useRef(false);
  const [previous, setPrevious] = useState<{ scope: string; list: SuggestionWire[] } | null>(null);
  useEffect(() => {
    if (!active || !replyAllowed || !suggestions.data?.length) {
      setPrevious((current) => (current?.scope === scope ? current : null));
      return;
    }
    setPrevious({ scope, list: suggestions.data as SuggestionWire[] });
  }, [active, replyAllowed, scope, suggestions.data]);
  // 空结果也可能是发送时被服务端丢弃的旧请求；同一范围内只用非空候选替换。
  const list = (
    previous?.scope === scope
      ? previous.list
      : ((replyAllowed ? suggestions.data : undefined) ?? [])
  ) as SuggestionWire[];
  const loading = (replyAllowed && suggestions.isFetching) || busy;
  const error =
    refreshError?.context === requestContext.current
      ? refreshError.message
      : replyAllowed
        ? suggestions.error?.message
        : undefined;
  const visible = active;
  const trackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const track = trackRef.current;
    if (!visible || !track) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.defaultPrevented || track.scrollWidth <= track.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? track.clientWidth : 1;
      // 直接消费每帧位移，避免平滑滚动反复重启；整条候选只保留一个滚动面。
      track.scrollLeft += delta * unit;
      event.preventDefault();
    };
    track.addEventListener('wheel', onWheel, { passive: false });
    return () => track.removeEventListener('wheel', onWheel);
  }, [visible, kind, conv]);
  if (!visible) return null;

  return (
    <div
      className={`weq-int-suggest${historyOpen ? ' is-history-open' : ''}`}
      aria-label="推荐回复"
    >
      {historyOpen ? (
        <div id={historyId} className="weq-int-history-slot">
          <ReplySuggestionHistory
            key={`${kind}:${conv}`}
            kind={kind}
            conv={conv}
            revision={previous?.list}
            onInsert={onInsert}
            onLocate={onLocate}
          />
        </div>
      ) : null}
      <div className="weq-int-suggest-bar" aria-busy={loading}>
        <Lightbulb size={12} className="weq-int-suggest-icon" aria-hidden />
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {loading
            ? '正在生成推荐回复…'
            : error
              ? `推荐回复失败：${error}`
              : list.length
                ? '推荐回复已更新'
                : '暂无推荐回复'}
        </span>
        <div key={`${kind}:${conv}`} ref={trackRef} className="weq-int-suggest-track">
          {loading && list.length === 0 ? (
            <span className="weq-int-suggest-empty">正在生成推荐回复</span>
          ) : list.length === 0 ? (
            <span className="weq-int-suggest-empty" title={error}>
              {error ? '推荐回复失败，可重试' : replyAllowed ? '暂无推荐回复' : '等待对方新消息'}
            </span>
          ) : (
            list.map((s) => (
              <button
                key={`${s.tone ?? ''}:${s.text}`}
                type="button"
                className="weq-int-suggest-pill"
                title={`${s.tone ? `[${s.tone}] ` : ''}${s.text}\n点击填入输入框`}
                onClick={() => onInsert(s.text)}
              >
                {s.tone ? <span className="weq-int-suggest-tone">{s.tone}</span> : null}
                <span className="weq-int-suggest-text">{s.text}</span>
              </button>
            ))
          )}
        </div>
        {error && list.length > 0 ? (
          <span className="weq-int-suggest-error" title={error}>
            更新失败
          </span>
        ) : null}
        <button
          type="button"
          className={`weq-int-suggest-refresh${loading ? ' is-busy' : ''}`}
          title={error ? '重试推荐回复' : '换一批'}
          aria-label="换一批建议"
          aria-busy={loading}
          disabled={loading}
          onClick={async () => {
            if (refreshPending.current || loading) return;
            refreshPending.current = true;
            const expected = requestContext.current;
            setBusy(true);
            setRefreshError(null);
            try {
              const list = await client.account.intentSense.getSuggestions.query({
                kind,
                conv,
                revision: status.data?.suggestionRevision ?? 0,
                ...(latestMessageId !== undefined ? { targetId: latestMessageId } : {}),
                refresh: true,
              });
              if (requestContext.current === expected && list.length > 0)
                setPrevious({ scope, list });
            } catch (error) {
              if (requestContext.current === expected) {
                setRefreshError({
                  context: expected,
                  message: error instanceof Error ? error.message : String(error),
                });
                useToast.getState().push({
                  tone: 'error',
                  message: '刷新推荐回复失败',
                  detail: error instanceof Error ? error.message : String(error),
                });
              }
            } finally {
              refreshPending.current = false;
              setBusy(false);
            }
          }}
        >
          <RefreshCw size={12} />
        </button>
        <button
          type="button"
          className="weq-int-suggest-refresh"
          title={historyOpen ? '收起回复历史' : '展开回复历史'}
          aria-label={historyOpen ? '收起回复历史' : '展开回复历史'}
          aria-expanded={historyOpen}
          aria-controls={historyId}
          onClick={() => setHistoryScope(historyOpen ? null : scope)}
        >
          {historyOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
    </div>
  );
}

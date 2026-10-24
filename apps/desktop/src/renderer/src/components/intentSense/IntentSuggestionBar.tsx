/**
 * 回复建议条 —— composer 上方的一行候选回复 pills。
 *
 * 回复建议独立开启；API 不依赖意图感知引擎，本地只提供规则候选兜底。
 * 点击一条把文本填进 composer 草稿（onInsert）。手动换一批绕过候选缓存，
 * 不受自己发送后的自动推荐开关限制，等待期间仍保留原候选。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Lightbulb, RefreshCw } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useToast } from '../Toast';
import { useIntentSenseStatus } from './context';
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
}: {
  kind: 'c2c' | 'group';
  conv: string;
  /** 明确为空时，仅在自己发言后推荐已开启且消息已发送时查询。 */
  replyTargetId?: string | null;
  latestMessageId?: string | null;
  onInsert: (text: string) => void;
}): ReactElement | null {
  const [busy, setBusy] = useState(false);
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
  const visible = active && (list.length > 0 || loading);
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
    <div className="weq-int-suggest">
      <Lightbulb size={12} className="weq-int-suggest-icon" aria-hidden />
      <div key={`${kind}:${conv}`} ref={trackRef} className="weq-int-suggest-track">
        {loading && list.length === 0
          ? ['skeleton-0', 'skeleton-1', 'skeleton-2'].map((key) => (
              <span key={key} className="weq-int-suggest-pill is-skeleton" style={{ minWidth: 88 }}>
                <span>…</span>
              </span>
            ))
          : list.map((s) => (
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
            ))}
      </div>
      <button
        type="button"
        className={`weq-int-suggest-refresh${loading ? ' is-busy' : ''}`}
        title="换一批"
        aria-label="换一批建议"
        disabled={busy}
        onClick={async () => {
          if (refreshPending.current) return;
          refreshPending.current = true;
          const expected = requestContext.current;
          setBusy(true);
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
            if (requestContext.current === expected)
              useToast.getState().push({
                tone: 'error',
                message: '刷新推荐回复失败',
                detail: error instanceof Error ? error.message : String(error),
              });
          } finally {
            refreshPending.current = false;
            setBusy(false);
          }
        }}
      >
        <RefreshCw size={12} />
      </button>
    </div>
  );
}

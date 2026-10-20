/**
 * 回复建议条 —— composer 上方的一行候选回复 pills。
 *
 * 仅当「意图感知开启 + 回复建议开启 + 当前引擎可用」时由 chatPane 渲染。
 * 点击一条把文本填进 composer 草稿（onInsert）。刷新按钮走 refetch()（绕过
 * staleTime；后端侧还有同消息 90s 的请求级缓存，由 getSuggestions 自己把关）。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Lightbulb, RefreshCw } from 'lucide-react';
import { trpc } from '../../trpc/client';
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
  const engineOk =
    status.data?.engine === 'local' ? !!status.data.localReady : !!status.data?.apiConfigured;
  const active =
    replyAllowed &&
    !!status.data?.enabled &&
    overridden !== false &&
    engineOk &&
    !!status.data?.suggestionsEnabled;
  const suggestions = trpc.account.intentSense.getSuggestions.useQuery(
    {
      kind,
      conv,
      revision: status.data?.suggestionRevision ?? 0,
      replyAllowed,
      ...(latestMessageId !== undefined ? { targetId: latestMessageId } : {}),
    },
    {
      enabled: active,
      refetchOnWindowFocus: false,
      staleTime: 90_000,
      cacheTime: 0,
      retry: false,
    },
  );

  const list = (suggestions.data ?? []) as SuggestionWire[];
  const loading = suggestions.isFetching || busy;
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
        onClick={async () => {
          setBusy(true);
          try {
            await suggestions.refetch();
          } finally {
            setBusy(false);
          }
        }}
      >
        <RefreshCw size={12} />
      </button>
    </div>
  );
}

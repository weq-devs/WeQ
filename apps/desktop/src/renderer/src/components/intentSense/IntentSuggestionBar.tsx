/**
 * 回复建议条 —— composer 上方的一行候选回复 pills。
 *
 * 回复建议独立开启；API 不依赖意图感知引擎，本地只提供规则候选兜底。
 * 点击一条把文本填进 composer 草稿（onInsert）。手动换一批绕过候选缓存，
 * 不受自己发送后的自动推荐开关限制，等待期间仍保留原候选。
 */

import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { Lightbulb, RefreshCw, ChevronUp, ChevronDown, Square, Info, Play } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useToast } from '../Toast';
import { useIntentSenseStatus } from './context';
import { ReplySuggestionHistory } from './ReplySuggestionHistory';
import { ReplySuggestionDetailsPanel } from './ReplySuggestionDetailsPanel';
import type { ReplySuggestionHistoryEntry } from '@weq/service';
import { INTENT_TUNING } from '@weq/service/intent-context';
import { formatSuggestionAge } from '../../lib/suggestionExpiry';
import '../../styles/intent-sense.css';

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
  const [detail, setDetail] = useState<{
    scope: string;
    id?: string;
    anchor: HTMLButtonElement;
  } | null>(null);
  const historyId = useId();
  const [refreshError, setRefreshError] = useState<{ context: string; message: string } | null>(
    null,
  );
  const status = useIntentSenseStatus();
  const manual = status.data?.suggestionMode === 'manual';
  const replyAllowed =
    replyTargetId !== null || (status.data?.suggestAfterSelf === true && !!latestMessageId);
  const overridden = status.data?.conversationOverrides?.[`${kind}:${conv}`];
  const active = overridden !== false && !!status.data?.suggestionsEnabled;
  const scope = JSON.stringify([kind, conv, status.data?.suggestionRevision ?? 0, active]);
  const entry = useRef({ scope, at: Date.now() });
  if (entry.current.scope !== scope) entry.current = { scope, at: Date.now() };
  const [stopped, setStopped] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [actionHovered, setActionHovered] = useState(false);
  const messageContext = JSON.stringify([scope, latestMessageId, replyTargetId]);
  const history = trpc.account.intentSense.getSuggestionHistory.useQuery(
    { kind, conv },
    { enabled: active, refetchOnWindowFocus: false, staleTime: 0, cacheTime: 0, retry: false },
  );
  const latestHistory = history.data?.[0];
  const upToDate = !!latestMessageId && latestHistory?.target.msgId === latestMessageId;
  const expiryMinutes =
    status.data?.suggestionExpiryMinutes ?? INTENT_TUNING.suggestionExpiryMinutes.default;
  const suggestions = trpc.account.intentSense.getSuggestionRound.useQuery(
    {
      kind,
      conv,
      revision: status.data?.suggestionRevision ?? 0,
      replyAllowed,
      ...(latestMessageId !== undefined ? { targetId: latestMessageId } : {}),
    },
    {
      enabled:
        active &&
        !manual &&
        replyAllowed &&
        !history.isLoading &&
        !upToDate &&
        !stopping &&
        stopped !== messageContext,
      refetchOnWindowFocus: false,
      staleTime: (status.data?.suggestionCacheSeconds ?? 90) * 1000,
      cacheTime: 0,
      retry: false,
    },
  );

  const historyOpen = historyScope === scope;
  const requestContext = useRef('');
  requestContext.current = scope;
  const refreshPending = useRef(false);
  const requestEpoch = useRef(0);
  const [previous, setPrevious] = useState<{
    scope: string;
    round: ReplySuggestionHistoryEntry;
  } | null>(null);
  const recent =
    latestHistory &&
    (upToDate ||
      expiryMinutes === -1 ||
      (expiryMinutes > 0 && entry.current.at - latestHistory.createdAt <= expiryMinutes * 60_000))
      ? latestHistory
      : undefined;
  useEffect(() => {
    if (!active) {
      setPrevious(null);
      return;
    }
    const next = upToDate
      ? latestHistory
      : replyAllowed && suggestions.data
        ? suggestions.data
        : undefined;
    setPrevious((current) =>
      next ? { scope, round: next } : current?.scope === scope ? current : null,
    );
  }, [active, replyAllowed, scope, suggestions.data, upToDate, latestHistory]);
  useEffect(() => {
    if (!active || !recent) return;
    setPrevious((current) => (current?.scope === scope ? current : { scope, round: recent }));
  }, [active, scope, recent]);
  const previousData = useRef(suggestions.data);
  useEffect(() => {
    if (previousData.current === suggestions.data) return;
    previousData.current = suggestions.data;
    if (suggestions.data) void history.refetch();
  }, [suggestions.data, history.refetch]);
  // 空结果或停止本轮都不清空候选；时间限制只在进入会话时应用。
  const currentRound =
    previous?.scope === scope
      ? previous.round
      : ((replyAllowed ? suggestions.data : undefined) ?? recent);
  const list = currentRound?.suggestions ?? [];
  const loading =
    stopped !== messageContext &&
    ((!manual && !upToDate && replyAllowed && suggestions.isFetching) || busy);
  const showStop = loading && actionHovered;
  const showStart = !loading && (manual || stopped === messageContext);
  const currentTarget = currentRound?.target;
  const error =
    refreshError?.context === requestContext.current
      ? refreshError.message
      : replyAllowed
        ? suggestions.error?.message
        : undefined;
  const expiredAt =
    active && !loading && !error && !currentRound && !recent && latestHistory?.suggestions.length
      ? latestHistory.createdAt
      : undefined;
  const [, tick] = useState(0);
  useEffect(() => {
    if (expiredAt === undefined) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const age = Math.max(0, Date.now() - expiredAt);
      const unit = age < 60_000 ? 1000 : 60_000;
      timer = setTimeout(
        () => {
          tick((value) => value + 1);
          schedule();
        },
        unit - (age % unit),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [expiredAt]);
  const expiredAge = expiredAt !== undefined ? formatSuggestionAge(Date.now() - expiredAt) : null;
  const emptyText = error
    ? '推荐回复失败，可重试'
    : expiredAt !== undefined
      ? `暂无推荐回复（距上次推荐 ${expiredAge}，已过期）`
      : replyAllowed
        ? '暂无推荐回复'
        : '等待对方新消息';
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
      {detail?.scope === scope ? (
        <ReplySuggestionDetailsPanel
          key={detail.id ?? 'in-progress'}
          kind={kind}
          conv={conv}
          id={detail.id}
          generating={loading}
          anchor={detail.anchor}
          onClose={() => setDetail(null)}
        />
      ) : null}
      {historyOpen ? (
        <div id={historyId} className="weq-int-history-slot">
          <ReplySuggestionHistory
            key={`${kind}:${conv}`}
            history={history}
            currentRoundId={currentRound?.id}
            onDetails={(id, anchor) => setDetail({ scope, id, anchor })}
            onInsert={onInsert}
            onLocate={onLocate}
          />
        </div>
      ) : null}
      <div className="weq-int-suggest-bar" aria-busy={loading}>
        <button
          type="button"
          className="weq-int-suggest-refresh weq-int-suggest-locate"
          title="定位到当前推荐的最后一条输入消息"
          aria-label="定位到当前推荐的最后一条输入消息"
          disabled={!onLocate || !currentTarget}
          onClick={() => currentTarget && void onLocate?.(currentTarget)}
        >
          <Lightbulb size={12} className="weq-int-suggest-icon" aria-hidden />
        </button>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {loading
            ? '正在生成推荐回复…'
            : error
              ? `推荐回复失败：${error}`
              : list.length
                ? '推荐回复已更新'
                : emptyText}
        </span>
        <div key={`${kind}:${conv}`} ref={trackRef} className="weq-int-suggest-track">
          {loading && list.length === 0 ? (
            <span className="weq-int-suggest-empty">正在生成推荐回复</span>
          ) : expiredAge !== null ? (
            <span className="weq-int-suggest-empty weq-int-suggest-expired" title={emptyText}>
              <span className="weq-int-suggest-expired-label">上次推荐已过期</span>
              <span className="weq-int-suggest-expired-age"> · {expiredAge}前</span>
            </span>
          ) : list.length === 0 ? (
            <span className="weq-int-suggest-empty" title={error ?? emptyText}>
              {emptyText}
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
          {error && list.length > 0 ? (
            <span className="weq-int-suggest-error" title={error}>
              更新失败
            </span>
          ) : null}
        </div>
        <div className="weq-int-suggest-actions">
          <button
            type="button"
            className="weq-int-suggest-refresh"
            title="查看当前推荐详情"
            aria-label="查看当前推荐详情"
            disabled={!currentRound && !loading}
            onClick={(event) =>
              setDetail({
                scope,
                id: loading ? undefined : currentRound?.id,
                anchor: event.currentTarget,
              })
            }
          >
            <Info size={12} />
          </button>
          <button
            type="button"
            className={`weq-int-suggest-refresh weq-int-suggest-action${loading && !showStop ? ' is-busy' : ''}`}
            title={
              showStop
                ? '停止推荐回复'
                : error
                  ? '重试推荐回复'
                  : showStart
                    ? '开始推荐回复'
                    : '换一批'
            }
            aria-label={showStop ? '停止推荐回复' : showStart ? '开始推荐回复' : '换一批建议'}
            aria-busy={loading}
            disabled={stopping}
            onMouseEnter={() => setActionHovered(true)}
            onMouseLeave={() => setActionHovered(false)}
            onFocus={() => setActionHovered(true)}
            onBlur={() => setActionHovered(false)}
            onClick={async () => {
              if (loading) {
                if (stopping) return;
                const expected = scope;
                const stoppedContext = messageContext;
                setStopping(true);
                try {
                  await client.account.intentSense.stopSuggestions.mutate({ kind, conv });
                  if (requestContext.current === expected) {
                    requestEpoch.current++;
                    setStopped(stoppedContext);
                    setBusy(false);
                  }
                } catch (error) {
                  useToast.getState().push({
                    tone: 'error',
                    message: '停止推荐回复失败',
                    detail: error instanceof Error ? error.message : String(error),
                  });
                } finally {
                  setStopping(false);
                }
                return;
              }
              if (refreshPending.current || loading) return;
              refreshPending.current = true;
              const expected = requestContext.current;
              const epoch = ++requestEpoch.current;
              setStopped(null);
              setBusy(true);
              setRefreshError(null);
              try {
                const round = await client.account.intentSense.getSuggestionRound.query({
                  kind,
                  conv,
                  revision: status.data?.suggestionRevision ?? 0,
                  ...(latestMessageId !== undefined ? { targetId: latestMessageId } : {}),
                  refresh: true,
                });
                if (
                  requestContext.current === expected &&
                  requestEpoch.current === epoch &&
                  round
                ) {
                  setPrevious({ scope, round });
                  void history.refetch();
                }
              } catch (error) {
                if (requestContext.current === expected && requestEpoch.current === epoch) {
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
                if (requestEpoch.current === epoch) setBusy(false);
              }
            }}
          >
            {showStop ? (
              <Square size={12} />
            ) : showStart ? (
              <Play size={12} />
            ) : (
              <RefreshCw size={12} />
            )}
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
    </div>
  );
}

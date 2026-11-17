/**
 * 意图感知的会话级数据层（React Context）。
 *
 * chatPane 挂在 `.message-scroll` 外层：打开会话时一次性拉齐缓存
 * （listMessageAnalyses）+ 触发增量补分析（ensureAnalysis，后台跑），之后靠
 * onAnalyzed 订阅把新结果合并进内存 map。气泡组件经 useIntentSenseContext 读
 * 单条结果 / 触发悬停补分析 —— 深层组件不用逐层传 props。
 *
 * 版本号（version）驱动消费者重渲染：map 存在 ref 里保持稳定引用，每次合并
 * 后 bump 一次。
 */

import { NumericText } from '../NumericText';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { trpc, client } from '../../trpc/client';
import { modelSelectionKey } from '@weq/agentlab/model-selection';
import { RefreshCw } from 'lucide-react';
import type { IntentAnalysisProgress } from '@weq/service';
import {
  type IntentAnalysis,
  useIntentSenseStatus,
  type IntentSenseContextValue,
  IntentSenseContext,
} from './context.shared';

export function IntentSenseProvider({
  kind,
  conv,
  latestPeerMsgId,
  latestMessageId,
  latestSelfMessageIds,
  roamingMessageKey = '',
  manualPendingMessageIds,
  manualSingleMessageId,
  children,
}: {
  kind: 'c2c' | 'group';
  conv: string;
  latestPeerMsgId: string | null;
  latestMessageId?: string | null;
  latestSelfMessageIds?: readonly string[];
  /** 已加载漫游消息的身份快照；补入旧消息也要触发增量分析。 */
  roamingMessageKey?: string;
  /** 菜单手动分析的待处理消息，与自动批次、悬停请求共同驱动等待动画。 */
  manualPendingMessageIds?: ReadonlySet<string>;
  /** 单条手动分析始终显示等待胶囊，不受批量动画或常驻显示偏好影响。 */
  manualSingleMessageId?: string;
  children: ReactNode;
}) {
  const analysisMessageId = latestMessageId === undefined ? latestPeerMsgId : latestMessageId;
  const peerTarget = useRef(latestPeerMsgId);
  peerTarget.current = latestPeerMsgId;
  const utils = trpc.useUtils();
  const analysesRef = useRef(new Map<string, IntentAnalysis>());
  const requestedRef = useRef(new Set<string>());
  const unavailableRef = useRef(new Set<string>());
  const failedRef = useRef(new Map<string, string>());
  const batchPendingRef = useRef(new Set<string>());
  const [version, setVersion] = useState(0);
  const [settled, setSettled] = useState(false);
  const [retry, setRetry] = useState(0);
  const [cacheRead, setCacheRead] = useState<{
    scope: string;
    state: 'ready' | 'error';
  } | null>(null);
  const [batch, setBatch] = useState<{
    scope: string;
    running: boolean;
    total?: number;
    completed?: number;
    succeeded?: number;
    failed?: number;
    error?: string;
  } | null>(null);

  const status = useIntentSenseStatus();
  const statusData = status.data;
  const suggestAfterSelf = useRef(false);
  suggestAfterSelf.current = statusData?.suggestAfterSelf === true;
  const overridden = statusData?.conversationOverrides?.[`${kind}:${conv}`];
  const engineOk =
    statusData?.engine === 'local' ? !!statusData.localReady : !!statusData?.apiConfigured;
  const effective = !!statusData?.enabled && overridden !== false && engineOk;
  useEffect(() => {
    if (kind !== 'c2c' || !statusData?.profileEnabled || statusData.profileMode === 'manual')
      return;
    const timer = setTimeout(() => {
      void utils.account.intentSense.getProfile.invalidate({ peerUid: conv });
    }, 1000);
    return () => clearTimeout(timer);
  }, [
    kind,
    conv,
    analysisMessageId,
    roamingMessageKey,
    statusData?.profileEnabled,
    statusData?.profileMode,
    utils,
  ]);
  const autoAnalysisAllowed =
    statusData?.analysisMode !== 'manual' &&
    (latestPeerMsgId !== null || !analysisMessageId || statusData?.analyzeAfterSelf !== false);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const merge = useCallback(
    (results: IntentAnalysis[]): void => {
      if (results.length === 0) return;
      for (const r of results) {
        analysesRef.current.set(r.msgId, r);
        unavailableRef.current.delete(r.msgId);
        failedRef.current.delete(r.msgId);
      }
      bump();
    },
    [bump],
  );

  const engineKey = `${statusData?.engine ?? ''}::${modelSelectionKey(statusData?.providerRef)}::${statusData?.analysisContextMessages ?? ''}::${statusData?.analysisRevision ?? 0}::${statusData?.analyzeAfterSelf !== false}`;
  const scope = `${kind}:${conv}:${engineKey}`;
  const cacheState = cacheRead?.scope === scope ? cacheRead.state : 'loading';
  // 会话切换或引擎切换时同步清空内存态（放在拉取缓存之前，避免清理掉刚拉回的同轮结果）。
  const prevConvKeyRef = useRef(`${kind}:${conv}:${engineKey}`);
  if (prevConvKeyRef.current !== `${kind}:${conv}:${engineKey}`) {
    prevConvKeyRef.current = `${kind}:${conv}:${engineKey}`;
    analysesRef.current.clear();
    requestedRef.current.clear();
    unavailableRef.current.clear();
    failedRef.current.clear();
    batchPendingRef.current.clear();
  }

  const requestAnalysis = useCallback(
    (msgId: string) => {
      if (statusData?.analysisMode === 'manual') return;
      const expected = `${kind}:${conv}:${engineKey}`;
      if (prevConvKeyRef.current !== expected) return;
      if (
        analysesRef.current.has(msgId) ||
        requestedRef.current.has(msgId) ||
        unavailableRef.current.has(msgId)
      )
        return;
      requestedRef.current.add(msgId);
      failedRef.current.delete(msgId);
      bump();
      return client.account.intentSense.analyzeMessage
        .mutate({ kind, conv, msgId })
        .then((result) => {
          if (prevConvKeyRef.current !== expected) return false;
          requestedRef.current.delete(msgId);
          if (result) {
            merge([result as IntentAnalysis]);
            return true;
          }
          unavailableRef.current.add(msgId);
          bump();
          return false;
        })
        .catch((error: unknown) => {
          if (prevConvKeyRef.current !== expected) return false;
          requestedRef.current.delete(msgId);
          failedRef.current.set(msgId, error instanceof Error ? error.message : String(error));
          bump();
          return false;
        });
    },
    [kind, conv, engineKey, merge, bump, statusData?.analysisMode],
  );

  // 会话或配置变化时拉齐缓存；增量分析由下方独立目标驱动。
  useEffect(() => {
    if (!effective || !conv) return;
    let disposed = false;
    const expected = scope;
    setSettled(false);
    void client.account.intentSense.listMessageAnalyses
      .query({ kind, conv })
      .then((results) => {
        if (!disposed && prevConvKeyRef.current === expected) {
          merge(results as IntentAnalysis[]);
          setCacheRead({ scope: expected, state: 'ready' });
        }
      })
      .catch(() => {
        if (!disposed && prevConvKeyRef.current === expected)
          setCacheRead({ scope: expected, state: 'error' });
      });
    return () => {
      disposed = true;
    };
  }, [kind, conv, effective, scope, merge]);

  // 先订阅真实批次范围，再启动任务；服务端会补发当前在途快照。
  useEffect(() => {
    if (!effective || !conv) return;
    const expected = `${kind}:${conv}:${engineKey}`;
    let disposed = false;
    const sub = client.account.intentSense.onAnalysisProgress.subscribe(undefined, {
      onData: (event: IntentAnalysisProgress) => {
        if (
          disposed ||
          prevConvKeyRef.current !== expected ||
          event.kind !== kind ||
          event.conv !== conv ||
          event.revision !== (statusData?.analysisRevision ?? 0)
        )
          return;
        batchPendingRef.current = new Set(event.pendingIds);
        setBatch({
          scope: expected,
          running: event.pendingIds.length > 0,
          total: event.total,
          completed: event.completed,
          succeeded: event.completed - event.failed,
          failed: event.failed,
        });
        bump();
      },
      onError: () => undefined,
    });
    return () => {
      disposed = true;
      void sub.unsubscribe();
    };
  }, [kind, conv, effective, engineKey, statusData?.analysisRevision, bump]);

  // 最新可分析文本包含自己；建议刷新独立遵循自己发言后的推荐开关。
  useEffect(() => {
    if (!effective || !conv) return;
    if (!autoAnalysisAllowed) {
      setSettled(true);
      return;
    }
    let disposed = false;
    const expected = `${kind}:${conv}:${engineKey}`;
    setSettled(false);
    setBatch({ scope: expected, running: true });
    void client.account.intentSense.ensureAnalysis
      .mutate({ kind, conv })
      .then(async (stats) => {
        if (disposed || prevConvKeyRef.current !== expected) return;
        // 在途批次可能早于连发消息；再补一次整个配置范围，不能只补最后一条。
        if (
          analysisMessageId &&
          stats &&
          !stats.error &&
          !stats.skipped &&
          (stats.failed ?? 0) === 0 &&
          stats.latestMsgId !== analysisMessageId &&
          !analysesRef.current.has(analysisMessageId)
        ) {
          const next = await client.account.intentSense.ensureAnalysis.mutate({ kind, conv });
          if (disposed || prevConvKeyRef.current !== expected) return;
          stats = {
            ...next,
            analyzed: (stats.analyzed ?? 0) + (next.analyzed ?? 0),
            peerAnalyzed:
              (stats.peerAnalyzed ?? stats.analyzed ?? 0) +
              (next.peerAnalyzed ?? next.analyzed ?? 0),
          };
        }
        if (stats?.skipped || stats?.error) {
          setBatch({
            scope: expected,
            running: false,
            ...(stats.error ? { error: stats.error } : {}),
          });
          void utils.account.intentSense.getStatus.invalidate();
          return;
        }
        if (
          analysisMessageId &&
          stats &&
          !stats.error &&
          !stats.skipped &&
          (stats.failed ?? 0) === 0 &&
          stats.latestMsgId !== analysisMessageId &&
          !analysesRef.current.has(analysisMessageId)
        ) {
          await requestAnalysis(analysisMessageId);
        }
        if (disposed || prevConvKeyRef.current !== expected) return;
        // 结果订阅断线或晚于任务启动时仍以缓存校准，不让完成进度先于实际结果永久停住。
        if ((stats?.analyzed ?? 0) > 0) {
          const results = await client.account.intentSense.listMessageAnalyses.query({
            kind,
            conv,
          });
          if (disposed || prevConvKeyRef.current !== expected) return;
          merge(results as IntentAnalysis[]);
        }
        setBatch({
          scope: expected,
          running: false,
          total: (stats?.analyzed ?? 0) + (stats?.failed ?? 0),
          completed: (stats?.analyzed ?? 0) + (stats?.failed ?? 0),
          succeeded: stats?.analyzed ?? 0,
          failed: stats?.failed ?? 0,
        });
        void utils.account.intentSense.getStatus.invalidate();
      })
      .catch((error: unknown) => {
        if (!disposed && prevConvKeyRef.current === expected)
          setBatch({
            scope: expected,
            running: false,
            error: error instanceof Error ? error.message : String(error),
          });
      })
      .finally(() => {
        if (!disposed && prevConvKeyRef.current === expected) {
          batchPendingRef.current.clear();
          setSettled(true);
          bump();
        }
      });
    return () => {
      disposed = true;
    };
  }, [
    kind,
    conv,
    effective,
    autoAnalysisAllowed,
    engineKey,
    analysisMessageId,
    roamingMessageKey,
    requestAnalysis,
    utils,
    retry,
    merge,
    bump,
  ]);

  useEffect(() => {
    if (!batch || batch.running || batch.error || (batch.failed ?? 0) > 0) return;
    const timer = setTimeout(
      () => setBatch((current) => (current === batch ? null : current)),
      2000,
    );
    return () => clearTimeout(timer);
  }, [batch]);

  // 增量结果订阅。
  useEffect(() => {
    if (!effective || !conv) return;
    let disposed = false;
    const expected = `${kind}:${conv}:${engineKey}`;
    const sub = client.account.intentSense.onAnalyzed.subscribe(undefined, {
      onData: (event) => {
        if (
          !disposed &&
          prevConvKeyRef.current === expected &&
          event.kind === kind &&
          event.conv === conv
        ) {
          merge(event.results as IntentAnalysis[]);
        }
      },
      onError: () => undefined,
    });
    return () => {
      disposed = true;
      void sub.unsubscribe();
    };
  }, [kind, conv, effective, engineKey, merge]);

  const getAnalysis = useCallback((msgId: string) => analysesRef.current.get(msgId), []);
  const isUnavailable = useCallback((msgId: string) => unavailableRef.current.has(msgId), []);
  const isPending = useCallback(
    (msgId: string) =>
      requestedRef.current.has(msgId) ||
      batchPendingRef.current.has(msgId) ||
      manualPendingMessageIds?.has(msgId) === true,
    [manualPendingMessageIds],
  );
  const getFailure = useCallback((msgId: string) => failedRef.current.get(msgId), []);
  const isManualPending = useCallback(
    (msgId: string) => manualPendingMessageIds?.has(msgId) === true,
    [manualPendingMessageIds],
  );

  const value = useMemo<IntentSenseContextValue>(
    () => ({
      active: effective,
      automatic: statusData?.analysisMode !== 'manual',
      persistentDisplay: statusData?.persistentDisplay !== false,
      hoverDisplay: statusData?.hoverDisplay !== false,
      loadingAnimation: statusData?.loadingAnimation !== false,
      cacheState,
      version,
      getAnalysis,
      isUnavailable,
      isPending,
      isManualPending,
      manualSingleMessageId,
      getFailure,
      requestAnalysis,
      latestPeerMsgId,
      latestMessageId: analysisMessageId,
      latestSelfMessageIds: new Set(latestSelfMessageIds),
      settled,
      kind,
      conv,
    }),
    [
      effective,
      statusData?.analysisMode,
      statusData?.persistentDisplay,
      statusData?.hoverDisplay,
      statusData?.loadingAnimation,
      cacheState,
      version,
      getAnalysis,
      isUnavailable,
      isPending,
      isManualPending,
      manualSingleMessageId,
      getFailure,
      requestAnalysis,
      latestPeerMsgId,
      analysisMessageId,
      latestSelfMessageIds,
      settled,
      kind,
      conv,
    ],
  );

  const visibleBatch = effective && batch?.scope === `${kind}:${conv}:${engineKey}` ? batch : null;
  return (
    <IntentSenseContext.Provider value={value}>
      {children}
      {visibleBatch &&
      !visibleBatch.running &&
      (visibleBatch.error || (visibleBatch.failed ?? 0) > 0) ? (
        <div className="weq-int-batch" role="status" aria-live="polite" aria-atomic="true">
          <span
            title={
              visibleBatch.total === undefined
                ? visibleBatch.error
                : `已处理 ${visibleBatch.completed ?? 0}/${visibleBatch.total}，成功 ${visibleBatch.succeeded ?? 0}，失败 ${visibleBatch.failed ?? 0}`
            }
          >
            {visibleBatch.error ? (
              `分析未完成：${visibleBatch.error}`
            ) : (
              <NumericText>{`分析未完成：${visibleBatch.failed} 条消息失败`}</NumericText>
            )}
          </span>
          <button
            type="button"
            title="重试分析"
            aria-label="重试分析"
            onClick={() => setRetry((v) => v + 1)}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      ) : null}
    </IntentSenseContext.Provider>
  );
}
export type { IntentSenseContextValue, IntentAnalysis } from './context.shared';

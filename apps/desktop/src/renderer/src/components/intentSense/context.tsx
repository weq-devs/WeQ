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

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { trpc, client } from '../../trpc/client';

/** 与后端 IntentSenseResult 对齐（superjson 直传的形状）。 */
export interface IntentAnalysis {
  msgId: string;
  mine: boolean;
  sendTime: number;
  intent: string;
  emotion: string;
  intensity: number;
  sentiment: number;
  confidence: number;
  engine: 'local' | 'api';
  analyzedAt: number;
}

export interface IntentSenseContextValue {
  /** 功能在当前会话是否生效（总开关 + 引擎可用 + 会话未关）。 */
  active: boolean;
  /** 数据版本（每次合并 bump；消费者以此触发重渲染）。 */
  version: number;
  /** 读单条结果（未分析过返回 undefined）。 */
  getAnalysis: (msgId: string) => IntentAnalysis | undefined;
  /** 单条消息是否已确认为无文本（纯图片/表情/卡片）或分析不可用，避免悬停无限转圈。 */
  isUnavailable: (msgId: string) => boolean;
  /** 悬停未命中时单条触发（带去重：同一消息本会话只发一次）。 */
  requestAnalysis: (msgId: string) => void;
  /** 当前回复目标；最新有效消息来自自己时为空。 */
  latestPeerMsgId: string | null;
  /** 最新可分析文本（包含自己），作为常驻胶囊与增量分析目标。 */
  latestMessageId: string | null;
  /** 末尾连续自己发言的文本消息，分析完成后保留常驻胶囊。 */
  latestSelfMessageIds?: ReadonlySet<string>;
  /** 本轮 ensureAnalysis 已跑完（无结果的消息不再显示加载占位）。 */
  settled: boolean;
  /** 会话类型与 id（消费组件回传后端用）。 */
  kind: 'c2c' | 'group';
  conv: string;
}

const IntentSenseContext = createContext<IntentSenseContextValue | null>(null);

export function useIntentSenseContext(): IntentSenseContextValue | null {
  return useContext(IntentSenseContext);
}

/**
 * 全局状态查询（React Query 同 key 共享缓存，多处使用只发一次 IPC）。
 * header 好感度胶囊 / 回复建议条在 Provider 外，靠它判断功能是否开启。
 */
export function useIntentSenseStatus() {
  return trpc.account.intentSense.getStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
}

export function IntentSenseProvider({
  kind,
  conv,
  latestPeerMsgId,
  latestMessageId,
  latestSelfMessageIds,
  children,
}: {
  kind: 'c2c' | 'group';
  conv: string;
  latestPeerMsgId: string | null;
  latestMessageId?: string | null;
  latestSelfMessageIds?: readonly string[];
  children: ReactNode;
}) {
  const analysisMessageId = latestMessageId === undefined ? latestPeerMsgId : latestMessageId;
  const peerTarget = useRef(latestPeerMsgId);
  peerTarget.current = latestPeerMsgId;
  const utils = trpc.useUtils();
  const analysesRef = useRef(new Map<string, IntentAnalysis>());
  const requestedRef = useRef(new Set<string>());
  const unavailableRef = useRef(new Set<string>());
  const [version, setVersion] = useState(0);
  const [settled, setSettled] = useState(false);

  const status = useIntentSenseStatus();
  const statusData = status.data;
  const suggestAfterSelf = useRef(false);
  suggestAfterSelf.current = statusData?.suggestAfterSelf === true;
  const overridden = statusData?.conversationOverrides?.[`${kind}:${conv}`];
  const engineOk =
    statusData?.engine === 'local' ? !!statusData.localReady : !!statusData?.apiConfigured;
  const effective = !!statusData?.enabled && overridden !== false && engineOk;
  const autoAnalysisAllowed =
    latestPeerMsgId !== null || !analysisMessageId || statusData?.analyzeAfterSelf !== false;

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const merge = useCallback(
    (results: IntentAnalysis[]): void => {
      if (results.length === 0) return;
      for (const r of results) {
        analysesRef.current.set(r.msgId, r);
        unavailableRef.current.delete(r.msgId);
      }
      bump();
    },
    [bump],
  );

  const engineKey = `${statusData?.engine ?? ''}::${statusData?.providerRef?.providerId ?? ''}::${statusData?.providerRef?.model ?? ''}::${statusData?.analysisContextMessages ?? ''}::${statusData?.analysisRevision ?? 0}::${statusData?.analyzeAfterSelf !== false}`;
  // 会话切换或引擎切换时同步清空内存态（放在拉取缓存之前，避免清理掉刚拉回的同轮结果）。
  const prevConvKeyRef = useRef(`${kind}:${conv}:${engineKey}`);
  if (prevConvKeyRef.current !== `${kind}:${conv}:${engineKey}`) {
    prevConvKeyRef.current = `${kind}:${conv}:${engineKey}`;
    analysesRef.current.clear();
    requestedRef.current.clear();
    unavailableRef.current.clear();
  }

  const requestAnalysis = useCallback(
    (msgId: string) => {
      const expected = `${kind}:${conv}:${engineKey}`;
      if (prevConvKeyRef.current !== expected) return;
      if (
        analysesRef.current.has(msgId) ||
        requestedRef.current.has(msgId) ||
        unavailableRef.current.has(msgId)
      )
        return;
      requestedRef.current.add(msgId);
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
        .catch(() => {
          if (prevConvKeyRef.current !== expected) return false;
          requestedRef.current.delete(msgId);
          unavailableRef.current.add(msgId);
          bump();
          return false;
        });
    },
    [kind, conv, engineKey, merge, bump],
  );

  // 会话或配置变化时拉齐缓存；增量分析由下方独立目标驱动。
  useEffect(() => {
    if (!effective || !conv) return;
    let disposed = false;
    setSettled(false);
    void client.account.intentSense.listMessageAnalyses
      .query({ kind, conv })
      .then((results) => {
        if (!disposed) merge(results as IntentAnalysis[]);
      })
      .catch(() => {
        /* 无账号会话等场景静默 */
      });
    return () => {
      disposed = true;
    };
  }, [kind, conv, effective, engineKey, merge]);

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
          void utils.account.intentSense.getStatus.invalidate();
          return;
        }
        let extra = false;
        if (
          analysisMessageId &&
          stats &&
          !stats.error &&
          !stats.skipped &&
          (stats.failed ?? 0) === 0 &&
          stats.latestMsgId !== analysisMessageId &&
          !analysesRef.current.has(analysisMessageId)
        ) {
          extra = (await requestAnalysis(analysisMessageId)) === true;
        }
        if (disposed || prevConvKeyRef.current !== expected) return;
        const extraPeer =
          extra && analysisMessageId && analysesRef.current.get(analysisMessageId)?.mine === false;
        if ((stats?.peerAnalyzed ?? stats?.analyzed ?? 0) > 0 || extraPeer) {
          if (kind === 'c2c') {
            void utils.account.intentSense.getProfile.invalidate({ peerUid: conv });
          }
        }
        if (
          (peerTarget.current || suggestAfterSelf.current) &&
          ((stats?.analyzed ?? 0) > 0 || extra)
        )
          void utils.account.intentSense.getSuggestions.invalidate({ kind, conv });
        void utils.account.intentSense.getStatus.invalidate();
      })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed && prevConvKeyRef.current === expected) setSettled(true);
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
    requestAnalysis,
    utils,
  ]);

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

  const value = useMemo<IntentSenseContextValue>(
    () => ({
      active: effective,
      version,
      getAnalysis,
      isUnavailable,
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
      version,
      getAnalysis,
      isUnavailable,
      requestAnalysis,
      latestPeerMsgId,
      analysisMessageId,
      latestSelfMessageIds,
      settled,
      kind,
      conv,
    ],
  );

  return <IntentSenseContext.Provider value={value}>{children}</IntentSenseContext.Provider>;
}

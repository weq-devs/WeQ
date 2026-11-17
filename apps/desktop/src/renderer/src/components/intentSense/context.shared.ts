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

import { createContext, useContext } from 'react';
import { trpc } from '../../trpc/client';

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
  persistentDisplay?: boolean;
  hoverDisplay?: boolean;
  loadingAnimation?: boolean;
  automatic?: boolean;
  /** 当前会话缓存的读取状态；不把读取缓存误报为消息分析在途。 */
  cacheState?: 'loading' | 'ready' | 'error';
  /** 数据版本（每次合并 bump；消费者以此触发重渲染）。 */
  version: number;
  /** 读单条结果（未分析过返回 undefined）。 */
  getAnalysis: (msgId: string) => IntentAnalysis | undefined;
  /** 单条消息是否已确认为无文本（纯图片/表情/卡片）或分析不可用，避免悬停无限转圈。 */
  isUnavailable: (msgId: string) => boolean;
  /** 单条悬停分析是否在途，供消息下的加载窄条使用。 */
  isPending?: (msgId: string) => boolean;
  isManualPending?: (msgId: string) => boolean;
  manualSingleMessageId?: string;
  getFailure?: (msgId: string) => string | undefined;
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

export const IntentSenseContext = createContext<IntentSenseContextValue | null>(null);

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

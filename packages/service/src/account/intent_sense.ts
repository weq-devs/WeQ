/**
 * IntentSenseService — 逐条意图/情绪分析、推荐回复及兼容旧 IPC 的配置门面。
 *
 * 三层结构：
 *   • 配置（per account，JsonStore）：总开关、引擎选择（api | local）、API provider
 *     引用、回复建议开关、按会话覆盖。存储模式对齐 {@link AntiRecallService}。
 *   • 分析缓存（per conversation，惰性 JsonStore）：`msgId → 分析结果`，增量补分析
 *     （ensureAnalysis 只跑缓存里没有的消息），上限由 cacheEntries 配置，
 *     按发送时间裁剪最旧的。
 *   • 引擎：`api` = OpenAI 兼容结构化 JSON 调用（复用注入的 EndpointResolver，与
 *     助手/克隆体同一套 provider 配置）；`local` = 注入的 {@link IntentLocalEnginePort}
 *     （桌面版 utilityProcess 里的 Laya ONNX worker；web 版没有，保持 null）。
 *     API 引擎生成回复建议；本地或 API 不可用时使用本地意图候选，Laya 不生成自由文本。
 *
 * 画像委派给 InteractionProfileService：独立模型、情绪输入与运行状态，
 * 不读取这里的逐条分析缓存；共享配置文件和消息读取以兼容旧 IPC 与持久化格式。
 *
 * Renderer 驱动：intentSense tRPC router（getStatus / setConfig / ensureAnalysis /
 * getMessageAnalyses / analyzeMessage / getProfile / getSuggestions / onAnalyzed）。
 */

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccountSession } from '@weq/account';
import type { C2cMsg, C2cPartition, GroupMsg } from '@weq/db';
import type { GapHistoryService, GapFetchedMessage } from './gap_history';
import { mergeRoamingTimeline, timelineRowKey, type TimelineRow } from '../common/roaming_timeline';
import {
  pickMessageText,
  requestApiJson,
  parseApiUsage,
  normalizeModelSelection,
  modelSelectionKey,
  isDefaultModelSelection,
  type AgentLabEndpoint,
  type AgentLabModelSelection,
} from '@weq/agentlab';
import type { EndpointResolver } from './assistant';
import { JsonStore, readJsonFile, writeJsonFileAtomic } from '../common/json_store';
import { InteractionProfileService } from './interaction_profile';
import { extractJsonBlock } from './intent_json';
import { analyzePragmatics, calibrateIntentSense, type IntentContextTurn } from './intent_corpus';
import { getLogger, logErrorContext } from '../common/logger';
import {
  buildSuggestionPrompt,
  suggestionMentions,
  type SuggestionElement,
  type SuggestionMessage,
  type SuggestionPerson,
} from './intent_suggestion_prompt';
import {
  DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
  DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
  MAX_INTENT_CONTEXT_MESSAGES,
  isIntentContextCount,
  DEFAULT_INTENT_TUNING,
  INTENT_TUNING,
  INTENT_TUNING_KEYS,
  isIntentTuningValue,
  normalizeIntentTuning,
  DEFAULT_SUGGESTION_FALLBACK_TEXTS,
  DEFAULT_SUGGESTION_HISTORY_LIMIT,
  validateSuggestionFallbackTexts,
  sampleSuggestionFallback,
  type IntentTuning,
} from '../common/intent_context';

const logger = getLogger().child({ scope: 'intent-sense' });

// ── 分类体系 ────────────────────────────────────────────────────────────────

export const INTENT_LABELS = {
  question: '提问',
  request: '请求',
  greeting: '问候',
  share: '分享',
  praise: '夸赞',
  vent: '吐槽',
  joke: '玩梗',
  plan: '约定',
  info: '通知',
  chat: '闲聊',
  boast: '炫耀',
  flattery: '吹捧',
  banter: '调侃',
  perfunctory: '敷衍',
  gossip: '吃瓜',
  coquetry: '撒娇',
  other: '其他',
} as const;
export type IntentKind = keyof typeof INTENT_LABELS;

export const EMOTION_LABELS = {
  joy: '开心',
  excitement: '兴奋',
  admiration: '赞叹',
  neutral: '平静',
  sadness: '低落',
  anger: '生气',
  anxiety: '焦虑',
  affection: '亲昵',
  fatigue: '疲惫',
  curiosity: '好奇',
  shock: '震惊',
  aggrieved: '委屈',
  irony: '反讽',
  anticipation: '期待',
  embarrassed: '尴尬',
} as const;
export type EmotionKind = keyof typeof EMOTION_LABELS;

export type IntentConversationKind = 'c2c' | 'group';

/** 单条消息的分析结果（缓存与 IPC 共用形状）。 */
export interface IntentSenseResult {
  msgId: string;
  /** 是否本机发出（对方消息 = 画像聚合的输入）。 */
  mine: boolean;
  sendTime: number;
  intent: IntentKind;
  emotion: EmotionKind;
  /** 情绪强度 0-100。 */
  intensity: number;
  /** 情感倾向 -100（消极）..100（积极）。 */
  sentiment: number;
  /** 置信度 0..1。 */
  confidence: number;
  engine: 'local' | 'api';
  analyzedAt: number;
}

// ── 配置 ────────────────────────────────────────────────────────────────────

export interface IntentSenseConfig extends IntentTuning {
  featureSettingsVersion: 2;
  analysisMode: 'auto' | 'manual';
  profileMode: 'auto' | 'manual';
  suggestionMode: 'auto' | 'manual';
  profileEnabled: boolean;
  /** 意图感知开关，与推荐回复、互动画像分别保存。 */
  enabled: boolean;
  /** 引擎：api（OpenAI 兼容）| local（Laya ONNX worker）。 */
  engine: 'api' | 'local';
  /** api 引擎用的 provider 引用（与 agentlab provider 目录同一套）。 */
  providerRef: AgentLabModelSelection | null;
  /** 推荐回复独立使用的 API 模型，不跟随分析引擎或本地模型。 */
  suggestionProviderRef: AgentLabModelSelection | null;
  profileEngine: 'api' | 'local' | 'heuristic';
  profileProviderRef: AgentLabModelSelection | null;
  profileLocalModelId: 'auto' | 'laya-multilingual' | 'QWeQ-NineBird-v1';
  /** 回复建议开关；生成式回复使用 API，失败时保留规则候选兜底。 */
  suggestionsEnabled: boolean;
  /** 最新消息为自己发送时是否自动分析，旧配置默认开启。 */
  analyzeAfterSelf: boolean;
  /** 消息下方常驻展示结果与分析加载条。 */
  persistentDisplay: boolean;
  /** 悬停消息时展示详情并允许单条补分析。 */
  hoverDisplay: boolean;
  loadingAnimation: boolean;
  suggestionFallbackEnabled: boolean;
  suggestionFallbackTexts: string[];
  /** 最新消息为自己发送时是否继续生成候选，始终不自动发送。 */
  suggestAfterSelf: boolean;
  /** 分析目标之前的上文条数，不含目标本身，仍受对话时效窗口限制。 */
  analysisContextMessages: number;
  /** 生成建议时回看的上文条数，不含最新消息。 */
  suggestionContextMessages: number;
  /** local 引擎下载模型时走 hf-mirror.com（国内镜像）。 */
  hfMirror: boolean;
  /** 按会话覆盖：true 强制开 / false 强制关；缺省跟随全局。key `${kind}:${id}`。 */
  conversationOverrides: Record<string, boolean>;
}

export interface IntentSenseStatus extends IntentSenseConfig {
  analysisRevision: number;
  suggestionRevision: number;
  profileRevision: number;
  /** resolveEndpoint + providerRef 都就绪，api 引擎可用。 */
  apiConfigured: boolean;
  suggestionApiConfigured: boolean;
  profileAvailable: boolean;
  lastSuggestionApiError?: string | null;
  /** local 引擎端口已注入（桌面版有，web 版没有）。 */
  localAvailable: boolean;
  /** local 引擎 worker 已启动且模型加载完成（分析真正可跑）。 */
  localReady: boolean;
  /** 最近一次 API 引擎调用失败原因（成功或切换配置后置 null）。 */
  lastApiError?: string | null;
}

const DEFAULT_CONFIG: IntentSenseConfig = {
  ...DEFAULT_INTENT_TUNING,
  featureSettingsVersion: 2,
  analysisMode: 'auto',
  profileMode: 'auto',
  suggestionMode: 'auto',
  profileEnabled: false,
  enabled: false,
  engine: 'api',
  providerRef: { useDefault: true },
  suggestionProviderRef: { useDefault: true },
  profileEngine: 'heuristic',
  profileProviderRef: { useDefault: true },
  profileLocalModelId: 'auto',
  suggestionsEnabled: false,
  analyzeAfterSelf: true,
  persistentDisplay: true,
  hoverDisplay: true,
  loadingAnimation: true,
  suggestionFallbackEnabled: true,
  suggestionFallbackTexts: [...DEFAULT_SUGGESTION_FALLBACK_TEXTS],
  suggestAfterSelf: true,
  analysisContextMessages: DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
  suggestionContextMessages: DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
  hfMirror: true,
  conversationOverrides: {},
};
export { DEFAULT_CONFIG as DEFAULT_INTENT_SENSE_CONFIG };

// ── 画像 ────────────────────────────────────────────────────────────────────

export interface MbtiDim {
  key: 'EI' | 'SN' | 'TF' | 'JP';
  /** 左侧极（E/S/T/J）的占比 0-100。 */
  leftPct: number;
}

export interface IntentProfile {
  /** 好感度 0-100（启发式综合，非客观事实）。 */
  affinity: number | null;
  /** 好感度档位 0-4（初识/熟络/亲近/挚友/羁绊）。 */
  tier: number | null;
  /** 近期逐日好感度走势（活跃日）。 */
  trend: Array<{ date: string; score: number }>;
  mbti: { letters: string; dims: MbtiDim[]; heuristic: boolean };
  /** 互动风格雷达 0-100。 */
  radar: Array<{ axis: string; value: number }>;
  /** 常见话题（分词 top）。 */
  topics: Array<{ topic: string; count: number }>;
  /** 参与聚合的消息数。 */
  sampled: number;
  /** 参与聚合的引擎分析结果数。 */
  analyzedSamples: number;
  engine: 'local' | 'api' | 'heuristic';
  computedAt: number;
}

/** 引擎侧的画像提示（可选增强；api 的结构化推断 / local 的 Laya 维度打分）。 */
export interface ProfileHints {
  engine?: 'api' | 'local';
  mbti?: MbtiDim[];
  radar?: Array<{ axis: string; value: number }>;
  topics?: string[];
  emotions?: Array<{ index: number; sentiment: number; intensity: number }>;
}

/** 回复建议（api 引擎生成）。 */
export interface ReplySuggestion {
  text: string;
  /** 风格提示（如 共情 / 幽默 / 简短）。 */
  tone?: string;
}

// ── 本地引擎端口（桌面版注入）──────────────────────────────────────────────

export interface IntentLocalAnalyzeOptions {
  /** 当前消息是否为本机发出。 */
  mine?: boolean;
  /** 紧邻的前序对话上下文（按时间升序）。 */
  context?: IntentContextTurn[];
  /** 语料库与上下文预分析生成的语用提示（辅助模型理解反语/夸张/网络黑话）。 */
  pragmaticHint?: string | null;
}

/**
 * Laya ONNX worker 的服务侧视图。桌面版在主进程里持有 utilityProcess 桥并实现
 * 这个接口；service 层只依赖它，不感知 Electron。web 版不注入（null）。
 */
export interface IntentLocalEnginePort {
  /** 按资源选择独立端口；相同资源可复用同一 worker。 */
  forModel?(modelId: string): IntentLocalEnginePort;
  /** worker 存活且模型已加载。 */
  readonly ready: boolean;
  /** 单条文本（可选附加上下文与语用提示） → 意图/情绪（Laya choice + score）。 */
  analyze(
    text: string,
    options?: IntentLocalAnalyzeOptions,
  ): Promise<{
    intent: IntentKind;
    emotion: EmotionKind;
    intensity: number;
    sentiment: number;
    confidence: number;
  } | null>;
  /** 对方消息样本 → MBTI 维度提示（Laya score/noul）。 */
  inferMbti(samples: string[]): Promise<MbtiDim[] | null>;
}

/** onAnalyzed 事件：新结果写入内存缓存后推给 renderer；本地批次按块合并落盘。 */
export interface IntentAnalyzedEvent {
  kind: IntentConversationKind;
  conv: string;
  results: IntentSenseResult[];
}

/** 自动补齐批次的真实进度；不含缓存命中与纯媒体消息。 */
export interface IntentAnalysisProgress {
  kind: IntentConversationKind;
  conv: string;
  revision: number;
  total: number;
  completed: number;
  failed: number;
  pendingIds: string[];
}

export interface ReplySuggestionHistoryEntry {
  id: string;
  createdAt: number;
  target: { msgId: string; msgSeq?: string; senderUin: string; sendTime: number };
  suggestions: ReplySuggestion[];
  summary?: string;
  generation?: {
    source: 'api' | 'local' | 'fallback';
    model?: string;
    providerId?: string;
    providerName?: string;
    startedAt: number;
    durationMs: number;
    requestDurationMs?: number;
    inputMessages: number;
    usage?: ReturnType<typeof parseApiUsage>;
  };
}

export interface ReplySuggestionTrace {
  prompt?: { system: string; user: string };
  response?: string;
  error?: string;
  logs?: Array<{
    seq: number;
    ts: number;
    stage: string;
    level: 'info' | 'warn' | 'error';
    text: string;
  }>;
}

export interface ReplySuggestionDetails {
  entry: ReplySuggestionHistoryEntry | null;
  trace: ReplySuggestionTrace | null;
  progress?: {
    id: string;
    status: 'running' | 'completed' | 'stopped' | 'failed';
    stage: string;
    startedAt: number;
    updatedAt: number;
  };
}

function normalizeSuggestionGeneration(raw: unknown): ReplySuggestionHistoryEntry['generation'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const nonnegative = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (
    (value.source !== 'api' && value.source !== 'local' && value.source !== 'fallback') ||
    !nonnegative(value.startedAt) ||
    !Number.isFinite(new Date(value.startedAt).getTime()) ||
    !nonnegative(value.durationMs) ||
    !nonnegative(value.inputMessages) ||
    !Number.isInteger(value.inputMessages)
  )
    return undefined;
  const usage =
    value.usage && typeof value.usage === 'object'
      ? (value.usage as Record<string, unknown>)
      : undefined;
  return {
    source: value.source,
    startedAt: value.startedAt,
    durationMs: value.durationMs,
    inputMessages: value.inputMessages,
    model: typeof value.model === 'string' ? value.model : undefined,
    providerId: typeof value.providerId === 'string' ? value.providerId : undefined,
    providerName: typeof value.providerName === 'string' ? value.providerName : undefined,
    requestDurationMs: nonnegative(value.requestDurationMs) ? value.requestDurationMs : undefined,
    usage: usage
      ? parseApiUsage({
          usage: {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
          },
        })
      : undefined,
  };
}

export const MAX_SUGGESTION_HISTORY = DEFAULT_SUGGESTION_HISTORY_LIMIT;

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 缓存 schema 版本：升级语料库/分类体系后自动淘汰旧版无上下文缓存。 */
const CACHE_SCHEMA_VERSION = 5;

function conversationKey(kind: IntentConversationKind, id: string): string {
  return `${kind}:${id}`;
}

/** 文件名安全的会话键（uid 带 `u_`，群号纯数字，本来就行；兜底替换）。 */
function fileSafe(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

type SenseElement = SuggestionElement;

/** 消息 → 供分析的文本：text + at + face 段；纯媒体消息返回 ''（不做分析）。 */
function elementsToSenseText(elements: SenseElement[]): string {
  const parts: string[] = [];
  for (const el of elements) {
    if (el.kind === 'text' || el.kind === 'at') {
      const t = String(el.textContent ?? '').trim();
      if (t) parts.push(t);
    } else if (el.kind === 'face') {
      const t = String(el.faceText ?? '').trim();
      if (t) parts.push(t);
    }
  }
  return parts.join(' ').trim();
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function normalizeIntent(v: unknown): IntentKind {
  return typeof v === 'string' && v in INTENT_LABELS ? (v as IntentKind) : 'other';
}

function normalizeEmotion(v: unknown): EmotionKind {
  return typeof v === 'string' && v in EMOTION_LABELS ? (v as EmotionKind) : 'neutral';
}

/** 按配置提取目标之前的紧邻上文，严格遵守时效性窗口。 */
function extractContextBefore(
  rows: readonly SenseRow[],
  targetIndex: number,
  maxMessages: number,
  tuning: Pick<IntentTuning, 'contextGapMinutes' | 'contextSpanMinutes'>,
): IntentContextTurn[] {
  const target = rows[targetIndex];
  if (!target || targetIndex <= 0) return [];
  const picked: IntentContextTurn[] = [];
  let nextTime = target.sendTime;
  for (let i = targetIndex - 1; i >= 0 && picked.length < maxMessages; i--) {
    const prev = rows[i];
    if (!prev?.text) continue;
    // 两个时效上限独立约束，超出任何一个即停止追溯。
    if (nextTime > 0 && prev.sendTime > 0) {
      const stepGap = nextTime - prev.sendTime;
      const totalSpan = target.sendTime - prev.sendTime;
      if (
        stepGap > tuning.contextGapMinutes * 60 ||
        totalSpan > tuning.contextSpanMinutes * 60 ||
        stepGap < 0
      ) {
        break;
      }
    }
    const gapSec =
      target.sendTime > 0 && prev.sendTime > 0 ? Math.max(0, target.sendTime - prev.sendTime) : 30;
    const freshness =
      target.sendTime > 0 && prev.sendTime > 0
        ? Math.max(
            0,
            Math.min(1, 1 - (target.sendTime - prev.sendTime) / (tuning.contextSpanMinutes * 60)),
          )
        : 1;
    picked.push({
      mine: prev.mine,
      text: prev.text,
      sendTime: prev.sendTime,
      gap_sec: gapSec,
      freshness,
    });
    nextTime = prev.sendTime;
  }
  return picked.reverse();
}

// ── 缓存条目形状（JsonStore normalize 用）──────────────────────────────────

interface CacheFile {
  version?: number;
  contextMessages?: number;
  modelIdentity?: string;
  results: IntentSenseResult[];
}

function normalizeCacheFile(
  raw: unknown,
  contextMessages: number,
  modelIdentity?: string,
): CacheFile {
  const obj = raw as {
    version?: unknown;
    results?: unknown;
    contextMessages?: unknown;
    modelIdentity?: unknown;
  } | null;
  const empty = { version: CACHE_SCHEMA_VERSION, contextMessages, modelIdentity, results: [] };
  if (
    obj?.version !== CACHE_SCHEMA_VERSION ||
    obj.contextMessages !== contextMessages ||
    (modelIdentity !== undefined && obj.modelIdentity !== modelIdentity)
  )
    return empty;
  const list = obj?.results;
  if (!Array.isArray(list)) return empty;
  const results: IntentSenseResult[] = [];
  for (const item of list) {
    const r = item as Partial<IntentSenseResult> | null;
    if (!r || typeof r.msgId !== 'string' || !r.msgId) continue;
    if (typeof r.sendTime !== 'number' || !Number.isFinite(r.sendTime)) continue;
    results.push({
      msgId: r.msgId,
      mine: r.mine === true,
      sendTime: r.sendTime,
      intent: normalizeIntent(r.intent),
      emotion: normalizeEmotion(r.emotion),
      intensity: clamp(Number(r.intensity ?? 50) || 0, 0, 100),
      sentiment: clamp(Number(r.sentiment ?? 0) || 0, -100, 100),
      confidence: clamp(Number(r.confidence ?? 0.5) || 0, 0, 1),
      engine: r.engine === 'local' ? 'local' : 'api',
      analyzedAt: Number(r.analyzedAt ?? 0) || 0,
    });
  }
  return { version: CACHE_SCHEMA_VERSION, contextMessages, modelIdentity, results };
}

export interface IntentSenseOptions {
  /** 旧画像跟随本地意图资源时，一次性固化当前选择。 */
  legacyLocalModelId?: string;
  /** api 引擎端点解析（与 AssistantService 同源的注入）。 */
  resolveEndpoint?: EndpointResolver;
  /** local 引擎端口（桌面版 utilityProcess 桥；web 版缺省 null）。 */
  localEngine?: IntentLocalEnginePort | null;
  /** 只读已落盘的漫游缓存，不发起 QQ 漫游请求。 */
  gapHistory?: Pick<GapHistoryService, 'cachedTimeline'>;
}

/** ensureAnalysis 的执行统计。 */
export interface EnsureStats {
  cached: number;
  analyzed: number;
  peerAnalyzed?: number;
  failed: number;
  /** 本次读取快照的最新消息；客户端可补齐旧在途批次之后到达的目标。 */
  latestMsgId?: string;
  skipped?: 'disabled' | 'config-changed';
  error?: string;
}

export class IntentSenseService {
  private analysisRevision = 0;
  private suggestionRevision = 0;
  private profileRevision = 0;
  private readonly profileService: InteractionProfileService;
  private readonly configStore: JsonStore<IntentSenseConfig>;
  private readonly analysisStores = new Map<string, JsonStore<CacheFile>>();
  /** 每会话在途 ensureAnalysis（去重并发）。 */
  private readonly inFlight = new Map<string, Promise<EnsureStats>>();
  private readonly analyzedListeners = new Set<(e: IntentAnalyzedEvent) => void>();
  private readonly progressListeners = new Set<(e: IntentAnalysisProgress) => void>();
  private readonly analysisProgress = new Map<string, IntentAnalysisProgress>();
  /** 回复建议缓存 `${kind}:${conv}` → 输入末条与实际轮次。 */
  private readonly suggestionCache = new Map<
    string,
    {
      lastMsgId: string;
      at: number;
      round: ReplySuggestionHistoryEntry;
      trace?: ReplySuggestionTrace;
    }
  >();
  private readonly suggestionHistoryStores = new Map<
    string,
    JsonStore<ReplySuggestionHistoryEntry[]>
  >();
  /** 回复建议在途任务（去重并发，防止相同会话重复调用 API）。 */
  private readonly suggestionInFlight = new Map<string, Promise<ReplySuggestion[]>>();
  /** 结果与请求绑定；下一轮覆盖会话缓存时，旧请求仍返回自己的轮次。 */
  private readonly suggestionRounds = new WeakMap<
    Promise<ReplySuggestion[]>,
    { round?: ReplySuggestionHistoryEntry }
  >();
  private readonly suggestionControllers = new Map<string, AbortController>();
  /** 每会话仅保留最新运行快照；未完成的轮次不写入候选历史。 */
  private readonly suggestionDetails = new Map<
    string,
    { revision: number; details: ReplySuggestionDetails }
  >();
  /** API 熔断截止时间戳（ms）：网络/服务报错后短时间内不再重复撞墙。 */
  private apiCooldownUntil = 0;
  /** 最近一次 API 请求失败信息（供设置面板提示用户排查网络/Provider）。 */
  private lastApiError: string | null = null;
  private suggestionApiCooldownUntil = 0;
  private lastSuggestionApiError: string | null = null;
  private readonly defaultIdentities = new Map<string, string>();

  constructor(
    private readonly session: AccountSession,
    private readonly storeDir: string,
    private readonly opts: IntentSenseOptions = {},
  ) {
    let migrateSuggestionRef = false;
    let migrateFeatures = false;
    let migrateProfile = false;
    this.configStore = new JsonStore(`${storeDir}/config.json`, () => ({ ...DEFAULT_CONFIG }), {
      normalize: (raw) => {
        const p = (raw ?? {}) as Partial<IntentSenseConfig>;
        const ref = p.providerRef as AgentLabModelSelection | null | undefined;
        migrateFeatures = p.featureSettingsVersion === undefined;
        migrateProfile = p.featureSettingsVersion !== 2;
        const follows = !p.profileEngine || (p.profileEngine as string) === 'follow';
        migrateSuggestionRef = p.suggestionProviderRef === undefined;
        // 旧本地引擎不继承历史分析模型；缺少推荐模型时使用全局默认。
        const suggestionRef = migrateSuggestionRef
          ? p.engine === 'local'
            ? null
            : ref
          : p.suggestionProviderRef;
        return {
          ...normalizeIntentTuning({
            ...p,
            profileApiTimeoutSeconds: p.profileApiTimeoutSeconds ?? p.apiTimeoutSeconds,
            profileApiCooldownSeconds: p.profileApiCooldownSeconds ?? p.apiCooldownSeconds,
          }),
          featureSettingsVersion: 2,
          analysisMode: p.analysisMode === 'manual' ? 'manual' : 'auto',
          profileMode: p.profileMode === 'manual' ? 'manual' : 'auto',
          suggestionMode: p.suggestionMode === 'manual' ? 'manual' : 'auto',
          profileEnabled: migrateFeatures ? p.enabled === true : p.profileEnabled === true,
          enabled: p.enabled === true,
          engine: p.engine === 'local' ? 'local' : 'api',
          providerRef: ref == null ? { useDefault: true } : normalizeModelSelection(ref),
          suggestionProviderRef:
            suggestionRef == null ? { useDefault: true } : normalizeModelSelection(suggestionRef),
          suggestionsEnabled:
            p.suggestionsEnabled === true && (!migrateFeatures || p.enabled === true),
          profileEngine:
            p.profileEngine === 'api' ||
            p.profileEngine === 'local' ||
            p.profileEngine === 'heuristic'
              ? p.profileEngine
              : p.engine === 'local'
                ? 'local'
                : 'api',
          profileProviderRef:
            (migrateProfile && follows ? ref : p.profileProviderRef) == null
              ? { useDefault: true }
              : normalizeModelSelection(migrateProfile && follows ? ref : p.profileProviderRef),
          profileLocalModelId:
            p.profileLocalModelId === 'laya-multilingual' ||
            p.profileLocalModelId === 'QWeQ-NineBird-v1'
              ? p.profileLocalModelId
              : migrateProfile &&
                  (follows || p.profileEngine === 'local') &&
                  (this.opts.legacyLocalModelId === 'laya-multilingual' ||
                    this.opts.legacyLocalModelId === 'QWeQ-NineBird-v1')
                ? this.opts.legacyLocalModelId
                : 'auto',
          analyzeAfterSelf: p.analyzeAfterSelf !== false,
          persistentDisplay: p.persistentDisplay !== false,
          hoverDisplay: p.hoverDisplay !== false,
          loadingAnimation: p.loadingAnimation !== false,
          suggestionFallbackEnabled: p.suggestionFallbackEnabled !== false,
          suggestionFallbackTexts: (() => {
            try {
              return validateSuggestionFallbackTexts(
                p.suggestionFallbackTexts ?? DEFAULT_SUGGESTION_FALLBACK_TEXTS,
              );
            } catch {
              return [...DEFAULT_SUGGESTION_FALLBACK_TEXTS];
            }
          })(),
          suggestAfterSelf: p.suggestAfterSelf !== false,
          analysisContextMessages: isIntentContextCount(p.analysisContextMessages)
            ? p.analysisContextMessages
            : DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
          suggestionContextMessages: isIntentContextCount(p.suggestionContextMessages)
            ? p.suggestionContextMessages
            : DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
          hfMirror: p.hfMirror !== false,
          conversationOverrides:
            p.conversationOverrides && typeof p.conversationOverrides === 'object'
              ? Object.fromEntries(
                  Object.entries(p.conversationOverrides).filter(
                    ([k, v]) => typeof k === 'string' && typeof v === 'boolean',
                  ),
                )
              : {},
        };
      },
    });
    if (migrateSuggestionRef || migrateFeatures || migrateProfile) this.configStore.save();
    this.profileService = new InteractionProfileService(
      () => this.config,
      (kind, peerUid, limit) => this.loadMessages(kind, peerUid, limit),
      (ref) => this.endpoint(ref),
      { localEngine: this.opts.localEngine },
    );
  }

  // ── 配置与状态 ───────────────────────────────────────────────────────────

  private get config(): IntentSenseConfig {
    return this.configStore.data;
  }

  private apiRefAvailable(ref: AgentLabModelSelection | null): boolean {
    return (
      !!this.opts.resolveEndpoint &&
      !!ref &&
      (!isDefaultModelSelection(ref) || !!this.endpoint(ref))
    );
  }

  private defaultIdentity(ref: AgentLabModelSelection | null): string {
    const endpoint = this.endpoint(ref);
    return endpoint?.modelIdentity ?? endpoint?.model ?? 'unavailable';
  }

  private analysisModelIdentity(): string | undefined {
    return this.config.engine === 'api' && isDefaultModelSelection(this.config.providerRef)
      ? this.defaultIdentity(this.config.providerRef)
      : undefined;
  }

  private syncDefaultModels(): void {
    const bindings: Array<[string, AgentLabModelSelection | null]> = [
      ['analysis', this.config.engine === 'api' ? this.config.providerRef : null],
      ['suggestion', this.config.suggestionProviderRef],
      ['profile', this.config.profileEngine === 'api' ? this.config.profileProviderRef : null],
    ];
    for (const [kind, ref] of bindings) {
      if (!isDefaultModelSelection(ref)) {
        this.defaultIdentities.delete(kind);
        continue;
      }
      const identity = this.defaultIdentity(ref);
      const previous = this.defaultIdentities.get(kind);
      this.defaultIdentities.set(kind, identity);
      if (previous === undefined || previous === identity) continue;
      if (kind === 'analysis') this.clearCache();
      if (kind === 'suggestion') {
        this.suggestionRevision++;
        this.suggestionCache.clear();
        this.suggestionInFlight.clear();
        this.suggestionApiCooldownUntil = 0;
        this.lastSuggestionApiError = null;
      }
      if (kind === 'profile') {
        this.profileRevision++;
        this.profileService.invalidate();
      }
    }
  }

  getStatus(): IntentSenseStatus {
    this.syncDefaultModels();
    return {
      ...this.config,
      analysisRevision: this.analysisRevision,
      suggestionRevision: this.suggestionRevision,
      profileRevision: this.profileRevision,
      apiConfigured: this.apiRefAvailable(this.config.providerRef),
      suggestionApiConfigured: this.apiRefAvailable(this.config.suggestionProviderRef),
      profileAvailable:
        this.config.profileEngine === 'heuristic' ||
        (this.config.profileEngine === 'api'
          ? this.apiRefAvailable(this.config.profileProviderRef)
          : !!(
              this.opts.localEngine?.forModel?.(this.config.profileLocalModelId) ??
              this.opts.localEngine
            )?.ready),
      lastSuggestionApiError: this.lastSuggestionApiError,
      localAvailable: !!this.opts.localEngine,
      localReady: !!this.opts.localEngine?.ready,
      lastApiError: this.lastApiError,
    };
  }

  async setConfig(
    patch: Partial<Omit<IntentSenseConfig, 'conversationOverrides'>>,
  ): Promise<IntentSenseStatus> {
    const previous = this.config;
    const next: IntentSenseConfig = { ...this.config };
    for (const key of ['analysisMode', 'profileMode', 'suggestionMode'] as const) {
      if (patch[key] === 'auto' || patch[key] === 'manual') next[key] = patch[key];
    }
    for (const key of INTENT_TUNING_KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      if (!isIntentTuningValue(key, value)) {
        if (key === 'analysisContextMessages' || key === 'suggestionContextMessages') {
          throw new Error(`上文条数必须是 0–${MAX_INTENT_CONTEXT_MESSAGES} 的整数`);
        }
        throw new Error(`${INTENT_TUNING[key].label}超出可设置范围`);
      }
      next[key] = value;
    }
    if (patch.profileEngine !== undefined) next.profileEngine = patch.profileEngine;
    if (patch.profileLocalModelId !== undefined)
      next.profileLocalModelId = patch.profileLocalModelId;
    if (patch.profileProviderRef !== undefined)
      next.profileProviderRef =
        patch.profileProviderRef === null
          ? { useDefault: true }
          : normalizeModelSelection(patch.profileProviderRef);
    if (
      next.profileSamples > next.profileMessages ||
      next.profileMinSamples > next.profileSamples
    ) {
      throw new Error('画像推断最少样本不能超过采样上限，采样上限不能超过统计消息范围');
    }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.profileEnabled === 'boolean') next.profileEnabled = patch.profileEnabled;
    if (patch.engine === 'api' || patch.engine === 'local') next.engine = patch.engine;
    if (patch.providerRef !== undefined) {
      next.providerRef =
        patch.providerRef === null
          ? { useDefault: true }
          : normalizeModelSelection(patch.providerRef);
    }
    if (patch.suggestionProviderRef !== undefined) {
      next.suggestionProviderRef =
        patch.suggestionProviderRef === null
          ? { useDefault: true }
          : normalizeModelSelection(patch.suggestionProviderRef);
    }
    if (typeof patch.suggestionsEnabled === 'boolean') {
      next.suggestionsEnabled = patch.suggestionsEnabled;
    }
    if (typeof patch.hfMirror === 'boolean') next.hfMirror = patch.hfMirror;
    if (typeof patch.analyzeAfterSelf === 'boolean') next.analyzeAfterSelf = patch.analyzeAfterSelf;
    if (typeof patch.persistentDisplay === 'boolean')
      next.persistentDisplay = patch.persistentDisplay;
    if (typeof patch.hoverDisplay === 'boolean') next.hoverDisplay = patch.hoverDisplay;
    if (typeof patch.loadingAnimation === 'boolean') next.loadingAnimation = patch.loadingAnimation;
    if (typeof patch.suggestionFallbackEnabled === 'boolean')
      next.suggestionFallbackEnabled = patch.suggestionFallbackEnabled;
    if (patch.suggestionFallbackTexts !== undefined)
      next.suggestionFallbackTexts = validateSuggestionFallbackTexts(patch.suggestionFallbackTexts);
    if (typeof patch.suggestAfterSelf === 'boolean') next.suggestAfterSelf = patch.suggestAfterSelf;
    const analysisChanged =
      next.analysisTemperature !== this.config.analysisTemperature ||
      next.engine !== this.config.engine ||
      modelSelectionKey(next.providerRef) !== modelSelectionKey(this.config.providerRef) ||
      next.contextGapMinutes !== this.config.contextGapMinutes ||
      next.contextSpanMinutes !== this.config.contextSpanMinutes ||
      next.analysisContextMessages !== this.config.analysisContextMessages ||
      next.analyzeAfterSelf !== this.config.analyzeAfterSelf;
    if (analysisChanged) {
      this.clearCache();
    } else if (
      next.backfillMessages !== this.config.backfillMessages ||
      next.enabled !== this.config.enabled
    ) {
      this.analysisRevision++;
    }
    if (
      analysisChanged ||
      next.suggestionsEnabled !== this.config.suggestionsEnabled ||
      modelSelectionKey(next.suggestionProviderRef) !==
        modelSelectionKey(this.config.suggestionProviderRef) ||
      next.suggestionContextMessages !== this.config.suggestionContextMessages ||
      next.suggestAfterSelf !== this.config.suggestAfterSelf ||
      next.suggestionTemperature !== this.config.suggestionTemperature ||
      next.suggestionCount !== this.config.suggestionCount ||
      next.suggestionTargetChars !== this.config.suggestionTargetChars ||
      next.suggestionCacheSeconds !== this.config.suggestionCacheSeconds ||
      next.suggestionFallbackEnabled !== this.config.suggestionFallbackEnabled ||
      JSON.stringify(next.suggestionFallbackTexts) !==
        JSON.stringify(this.config.suggestionFallbackTexts)
    ) {
      this.suggestionRevision++;
      this.suggestionCache.clear();
      this.suggestionInFlight.clear();
    }
    if (analysisChanged || next.enabled !== previous.enabled) {
      this.apiCooldownUntil = 0;
      this.lastApiError = null;
    }
    if (
      Object.keys(next).some(
        (key) =>
          key.startsWith('suggest') &&
          JSON.stringify(next[key as keyof IntentSenseConfig]) !==
            JSON.stringify(previous[key as keyof IntentSenseConfig]),
      )
    ) {
      this.suggestionApiCooldownUntil = 0;
      this.lastSuggestionApiError = null;
    }
    this.configStore.data = next;
    for (const store of this.analysisStores.values()) {
      if (store.data.results.length <= next.cacheEntries) continue;
      store.data = {
        ...store.data,
        results: [...store.data.results]
          .sort((a, b) => a.sendTime - b.sendTime)
          .slice(-next.cacheEntries),
      };
      store.save();
    }
    const profileChanged = Object.keys(next).some(
      (key) =>
        key !== 'profileMode' &&
        key.startsWith('profile') &&
        JSON.stringify(next[key as keyof IntentSenseConfig]) !==
          JSON.stringify(previous[key as keyof IntentSenseConfig]),
    );
    if (profileChanged) {
      this.profileRevision++;
      this.profileService.invalidate();
    }
    this.configStore.save();
    return this.getStatus();
  }

  /** 清空当前账号下所有会话的意图分析缓存与回复建议缓存，重置 API 熔断状态。 */
  clearCache(): { clearedFiles: number } {
    this.analysisRevision++;
    this.suggestionRevision++;
    let clearedFiles = 0;
    for (const store of this.analysisStores.values()) {
      store.data = {
        version: CACHE_SCHEMA_VERSION,
        contextMessages: this.config.analysisContextMessages,
        modelIdentity: this.analysisModelIdentity(),
        results: [],
      };
      store.save();
    }
    this.analysisStores.clear();
    this.suggestionCache.clear();
    this.suggestionInFlight.clear();
    this.suggestionDetails.clear();
    this.apiCooldownUntil = 0;
    this.lastApiError = null;
    this.suggestionApiCooldownUntil = 0;
    this.lastSuggestionApiError = null;
    const analysisDir = join(this.storeDir, 'analysis');
    if (existsSync(analysisDir)) {
      try {
        for (const name of readdirSync(analysisDir)) {
          if (name.endsWith('.json')) {
            try {
              unlinkSync(join(analysisDir, name));
              clearedFiles++;
            } catch {
              /* ignore single file unlink error */
            }
          }
        }
      } catch {
        /* ignore dir read error */
      }
    }
    return { clearedFiles };
  }

  /** 单会话开关（null = 清除覆盖、跟随全局）。 */
  async setConversationOverride(
    kind: IntentConversationKind,
    id: string,
    enabled: boolean | null,
  ): Promise<IntentSenseStatus> {
    const overrides = { ...this.config.conversationOverrides };
    const key = conversationKey(kind, id);
    if (enabled === null) delete overrides[key];
    else overrides[key] = enabled;
    this.configStore.data = { ...this.config, conversationOverrides: overrides };
    this.configStore.save();
    return this.getStatus();
  }

  /** 该会话当前是否生效（总开关 && 覆盖未关 && 引擎可用）。 */
  effectiveFor(kind: IntentConversationKind, id: string): boolean {
    this.syncDefaultModels();
    if (!this.config.enabled) return false;
    const override = this.config.conversationOverrides[conversationKey(kind, id)];
    if (override === false) return false;
    if (this.config.engine === 'local') return !!this.opts.localEngine?.ready;
    return this.apiRefAvailable(this.config.providerRef);
  }

  // ── 事件 ─────────────────────────────────────────────────────────────────

  /** 订阅增量分析结果；返回退订函数（tRPC subscription 包装它）。 */
  onAnalyzed(cb: (e: IntentAnalyzedEvent) => void): () => void {
    this.analyzedListeners.add(cb);
    return () => {
      this.analyzedListeners.delete(cb);
    };
  }

  onAnalysisProgress(cb: (e: IntentAnalysisProgress) => void): () => void {
    this.progressListeners.add(cb);
    // 切换回来或订阅晚于批次启动时也能恢复当前进度。
    for (const progress of this.analysisProgress.values()) {
      if (progress.revision === this.analysisRevision) cb(progress);
    }
    return () => {
      this.progressListeners.delete(cb);
    };
  }

  private emitAnalysisProgress(progress: IntentAnalysisProgress): void {
    const key = conversationKey(progress.kind, progress.conv);
    if (progress.pendingIds.length) this.analysisProgress.set(key, progress);
    else this.analysisProgress.delete(key);
    for (const cb of this.progressListeners) {
      try {
        cb(progress);
      } catch (error) {
        logger.warn('intent-sense progress listener failed', logErrorContext(error));
      }
    }
  }

  private emitAnalyzed(e: IntentAnalyzedEvent): void {
    for (const cb of this.analyzedListeners) {
      try {
        cb(e);
      } catch (error) {
        logger.warn('intent-sense listener failed', {
          event: 'intent-sense-listener-failed',
          ...logErrorContext(error),
        });
      }
    }
  }

  // ── 分析 ─────────────────────────────────────────────────────────────────

  /**
   * 增量补齐一个会话最近 `limit` 条消息的分析（只跑缓存没有的）。并发调用同一
   * 会话会合并成一次在途任务。返回 { cached, analyzed, failed }。
   */
  ensureAnalysis(
    kind: IntentConversationKind,
    conv: string,
    limit = this.config.backfillMessages,
  ): Promise<EnsureStats> {
    if (!this.effectiveFor(kind, conv) || this.config.analysisMode === 'manual') {
      return Promise.resolve({ cached: 0, analyzed: 0, failed: 0, skipped: 'disabled' });
    }
    const revision = this.analysisRevision;
    const key = `${conversationKey(kind, conv)}:${revision}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const task = this.runEnsure(kind, conv, limit, revision)
      .catch((error): EnsureStats => {
        logger.warn('intent-sense ensureAnalysis failed', {
          event: 'intent-sense-ensure-failed',
          ...logErrorContext(error),
        });
        return { cached: 0, analyzed: 0, failed: 0, error: String(error) };
      })
      .finally(() => {
        const progress = this.analysisProgress.get(conversationKey(kind, conv));
        if (progress?.revision === revision) {
          this.emitAnalysisProgress({ ...progress, pendingIds: [] });
        }
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, task);
    return task;
  }

  /** 悬停未命中时单条触发（消息 id 来自渲染层，bigint 已字符串化）。 */
  async analyzeMessage(
    kind: IntentConversationKind,
    conv: string,
    msgId: string,
    options?: { manual?: boolean },
  ): Promise<IntentSenseResult | null> {
    if (!this.effectiveFor(kind, conv)) return null;
    if (this.config.analysisMode === 'manual' && !options?.manual) return null;
    const revision = this.analysisRevision;
    const contextMessages = this.config.analysisContextMessages;
    const cache = this.cacheFor(kind, conv);
    const hit = cache.data.results.find(
      (r) =>
        r.msgId === msgId &&
        (this.config.engine === 'local' ||
          r.engine === 'api' ||
          Date.now() < this.apiCooldownUntil),
    );
    if (hit) return hit;

    // 优先从最近窗口定位该消息，以便一并拿到前序对话上下文；若不在近期窗口则回退按 ID 单查。
    const recent = await this.loadMessages(kind, conv, Math.max(60, contextMessages + 1));
    const idx = recent.findIndex((r) => r.msgId === msgId);
    let row: SenseRow | undefined;
    let context: IntentContextTurn[] = [];
    if (idx >= 0) {
      row = recent[idx];
      context = extractContextBefore(recent, idx, contextMessages, this.config);
    } else {
      const rows = await this.loadMessages(kind, conv, 1, [msgId]);
      row = rows[0];
      const roaming = /^roaming:(?:(?:native|protocol):)?([1-9]\d*):-?\d+$/.exec(msgId);
      if (row && roaming && contextMessages > 0) {
        const before = await this.loadMessages(
          kind,
          conv,
          Math.max(60, contextMessages),
          undefined,
          BigInt(roaming[1]!),
        );
        context = extractContextBefore(
          [...before, row],
          before.length,
          contextMessages,
          this.config,
        );
      }
    }
    if (!row?.text) return null;
    if (row.mine && !this.config.analyzeAfterSelf && !options?.manual) return null;
    this.syncDefaultModels();
    if (revision !== this.analysisRevision) return null;

    let result: IntentSenseResult | null = null;
    if (this.config.engine === 'local') {
      result = await this.analyzeOne(row.mine, row.sendTime, row.msgId, row.text, context);
    } else {
      const prag = analyzePragmatics(row.text, context, row.sendTime);
      if (prag.override?.hard) {
        result = {
          msgId: row.msgId,
          mine: row.mine,
          sendTime: row.sendTime,
          intent: prag.override.intent,
          emotion: prag.override.emotion,
          intensity: clamp(prag.override.intensity, 0, 100),
          sentiment: clamp(prag.override.sentiment, -100, 100),
          confidence: clamp(prag.override.minConfidence, 0, 1),
          engine: 'api',
          analyzedAt: Date.now(),
        };
      } else {
        const batchOut = await this.analyzeBatchViaApi([{ ...row, context }]);
        this.syncDefaultModels();
        if (revision !== this.analysisRevision) return null;
        if (batchOut !== null) {
          result = batchOut[0] ?? null;
        } else if (this.opts.localEngine?.ready) {
          result = await this.analyzeOne(row.mine, row.sendTime, row.msgId, row.text, context);
        }
      }
    }
    if (revision !== this.analysisRevision) return null;
    this.syncDefaultModels();
    if (revision !== this.analysisRevision) return null;
    if (result) {
      this.storeResults(kind, conv, [result]);
      this.emitAnalyzed({ kind, conv, results: [result] });
    }
    return result;
  }

  /** 渲染层批量取（一次读缓存，不做分析）。 */
  getMessageAnalyses(
    kind: IntentConversationKind,
    conv: string,
    msgIds: string[],
  ): IntentSenseResult[] {
    const wanted = new Set(msgIds);
    return this.cacheFor(kind, conv).data.results.filter((r) => wanted.has(r.msgId));
  }

  /** 该会话的全部已缓存结果（首屏一次拉齐，新结果走 onAnalyzed 增量）。 */
  listMessageAnalyses(kind: IntentConversationKind, conv: string): IntentSenseResult[] {
    return this.cacheFor(kind, conv).data.results;
  }

  private async runEnsure(
    kind: IntentConversationKind,
    conv: string,
    limit: number,
    revision: number,
  ): Promise<EnsureStats> {
    const contextMessages = this.config.analysisContextMessages;
    const current = () => {
      this.syncDefaultModels();
      return revision === this.analysisRevision;
    };
    const cache = this.cacheFor(kind, conv);
    // 当用户切换到 api 引擎且未处于熔断期时，之前由 local 引擎产生的缓存不视为最终命中，允许升级重算为 api 结果
    const known = new Set(
      cache.data.results
        .filter(
          (r) =>
            this.config.engine === 'local' ||
            r.engine === 'api' ||
            Date.now() < this.apiCooldownUntil,
        )
        .map((r) => r.msgId),
    );
    const rows = await this.loadMessages(kind, conv, limit + contextMessages);
    if (!current()) return { cached: 0, analyzed: 0, failed: 0, skipped: 'config-changed' };
    if (rows.at(-1)?.mine && !this.config.analyzeAfterSelf)
      return { cached: 0, analyzed: 0, failed: 0, skipped: 'disabled' };
    const startIndex = Math.max(0, rows.length - limit);
    const pending: Array<{ row: SenseRow; context: IntentContextTurn[] }> = [];
    for (let idx = startIndex; idx < rows.length; idx++) {
      const r = rows[idx]!;
      if (!known.has(r.msgId) && r.text) {
        pending.push({
          row: r,
          context: extractContextBefore(rows, idx, contextMessages, this.config),
        });
      }
    }
    let analyzed = 0;
    let peerAnalyzed = 0;
    let failed = 0;
    const remainingIds = new Set(pending.map(({ row }) => row.msgId));
    const progress = (): void => {
      if (!current()) return;
      this.emitAnalysisProgress({
        kind,
        conv,
        revision,
        total: pending.length,
        completed: analyzed + failed,
        failed,
        pendingIds: [...remainingIds],
      });
    };
    progress();
    if (pending.length > 0) {
      // 按最新分块优先处理（块内保持时间升序），确保用户首屏看到的最新消息最先点亮
      const chunks: Array<Array<{ row: SenseRow; context: IntentContextTurn[] }>> = [];
      for (let end = pending.length; end > 0; end -= this.config.apiBatchMessages) {
        const start = Math.max(0, end - this.config.apiBatchMessages);
        chunks.push(pending.slice(start, end));
      }

      const runChunkLocal = async (
        slice: Array<{ row: SenseRow; context: IntentContextTurn[] }>,
      ): Promise<void> => {
        let dirty = false;
        try {
          for (const { row, context } of slice) {
            if (!current()) return;
            const result = await this.analyzeOne(
              row.mine,
              row.sendTime,
              row.msgId,
              row.text,
              context,
            );
            if (!current()) return;
            if (result) {
              // 先让结果可读、可显示，再推进进度；磁盘仍按块合并写入。
              this.storeResults(kind, conv, [result], { persist: false });
              dirty = true;
              this.emitAnalyzed({ kind, conv, results: [result] });
              analyzed++;
              if (!result.mine) peerAnalyzed++;
            } else {
              failed++;
            }
            remainingIds.delete(row.msgId);
            progress();
          }
        } finally {
          // 配置切换清理过的旧 store 不能再写回；仅改范围/开关时保留已完成的有效结果。
          if (dirty && this.analysisStores.get(conversationKey(kind, conv)) === cache) cache.save();
        }
      };

      if (this.config.engine === 'local') {
        for (const slice of chunks) {
          if (!current()) break;
          await runChunkLocal(slice);
        }
      } else {
        for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
          if (!current()) break;
          const slice = chunks[cIdx]!;
          const directResults: IntentSenseResult[] = [];
          const apiSlice: typeof slice = [];

          for (const item of slice) {
            const prag = analyzePragmatics(item.row.text, item.context, item.row.sendTime);
            if (prag.override?.hard) {
              directResults.push({
                msgId: item.row.msgId,
                mine: item.row.mine,
                sendTime: item.row.sendTime,
                intent: prag.override.intent,
                emotion: prag.override.emotion,
                intensity: clamp(prag.override.intensity, 0, 100),
                sentiment: clamp(prag.override.sentiment, -100, 100),
                confidence: clamp(prag.override.minConfidence, 0, 1),
                engine: 'api',
                analyzedAt: Date.now(),
              });
            } else {
              apiSlice.push(item);
            }
          }

          let apiResults: IntentSenseResult[] | null = [];
          if (apiSlice.length > 0) {
            const batchInput = apiSlice.map(({ row, context }) => ({
              msgId: row.msgId,
              mine: row.mine,
              sendTime: row.sendTime,
              text: row.text,
              context,
            }));
            apiResults = await this.analyzeBatchViaApi(batchInput);
            if (!current()) break;
          }

          if (apiResults === null) {
            // API 发生网络故障或处于熔断冷却：若本地引擎就绪则无缝降级本地引擎，否则记录失败并中止
            if (this.opts.localEngine?.ready) {
              await runChunkLocal(apiSlice);
            } else {
              const remaining = chunks.slice(cIdx).reduce((acc, s) => acc + s.length, 0);
              failed += remaining - directResults.length;
            }
          }

          const combined = [...directResults, ...(apiResults ?? [])];
          if (combined.length > 0) {
            this.storeResults(kind, conv, combined);
            this.emitAnalyzed({ kind, conv, results: combined });
            analyzed += combined.length;
            peerAnalyzed += combined.filter((result) => !result.mine).length;
          }
          if (apiResults !== null) {
            failed += apiSlice.length - apiResults.length;
          } else if (!this.opts.localEngine?.ready) {
            remainingIds.clear();
            progress();
            break;
          }
          for (const { row } of slice) remainingIds.delete(row.msgId);
          progress();
        }
      }
    }
    return {
      cached: rows.length - startIndex - pending.length,
      analyzed,
      peerAnalyzed,
      failed,
      latestMsgId: rows.at(-1)?.msgId,
      ...(!current() ? { skipped: 'config-changed' as const } : {}),
    };
  }

  private async analyzeOne(
    mine: boolean,
    sendTime: number,
    msgId: string,
    text: string,
    context: IntentContextTurn[] = [],
  ): Promise<IntentSenseResult | null> {
    const port = this.opts.localEngine;
    if (!port?.ready) return null;
    try {
      const prag = analyzePragmatics(text, context, sendTime);
      const out = await port.analyze(text, {
        mine,
        context,
        pragmaticHint: prag.promptHint,
      });
      if (!out) return null;
      const calibrated = calibrateIntentSense(
        {
          intent: normalizeIntent(out.intent),
          emotion: normalizeEmotion(out.emotion),
          intensity: clamp(out.intensity, 0, 100),
          sentiment: clamp(out.sentiment, -100, 100),
          confidence: clamp(out.confidence, 0, 1),
        },
        text,
        context,
        sendTime,
      );
      return {
        msgId,
        mine,
        sendTime,
        intent: calibrated.intent,
        emotion: calibrated.emotion,
        intensity: clamp(calibrated.intensity, 0, 100),
        sentiment: clamp(calibrated.sentiment, -100, 100),
        confidence: clamp(calibrated.confidence, 0, 1),
        engine: 'local',
        analyzedAt: Date.now(),
      };
    } catch (error) {
      logger.debug('intent-sense local analyze failed', {
        event: 'intent-sense-local-failed',
        ...logErrorContext(error),
      });
      return null;
    }
  }

  // ── API 引擎 ─────────────────────────────────────────────────────────────

  private endpoint(
    ref: AgentLabModelSelection | null = this.config.providerRef,
  ): AgentLabEndpoint | null {
    if (!this.opts.resolveEndpoint || !ref) return null;
    try {
      return this.opts.resolveEndpoint(ref);
    } catch {
      return null;
    }
  }

  /**
   * 一次 OpenAI 兼容调用分析一批消息（带前序上下文 + 语用提示 + 后置校准）。
   * 返回 `null` 表示端点未就绪、处于熔断冷却或网络/HTTP 失败（调用方应熔断或降级本地引擎）。
   */
  private async analyzeBatchViaApi(
    batch: Array<{
      msgId: string;
      mine: boolean;
      sendTime: number;
      text: string;
      context: IntentContextTurn[];
    }>,
  ): Promise<IntentSenseResult[] | null> {
    const revision = this.analysisRevision;
    const endpoint = this.endpoint();
    if (!endpoint) return null;
    if (Date.now() < this.apiCooldownUntil) return null;
    const baseUrl = endpoint.baseUrl.replace(/\/+$/, '');
    const userContent = JSON.stringify({
      messages: batch.map((b, i) => ({
        i,
        speaker: b.mine ? '我' : '对方',
        text: b.text,
        context: b.context.map((turn) => ({ speaker: turn.mine ? '我' : '对方', text: turn.text })),
        hint: analyzePragmatics(b.text, b.context, b.sendTime).promptHint || undefined,
      })),
    });
    const system =
      '你是精通中文互联网语境、反语、夸张修辞与网络黑话的聊天消息意图/情绪分析专家。' +
      '请结合每条消息标注的上文，对输入 JSON 的 messages 中每条目标输出 intent/emotion/intensity/sentiment/confidence。\n' +
      '输入 JSON 中每条消息的 context 是该条唯一的上文；其它待分析项不是它的上文，不使用后续消息补充语境。\n' +
      `intent 只能是: ${Object.keys(INTENT_LABELS).join(', ')}（chat=闲聊, info=通知, question=提问, request=请求, greeting=问候, share=分享, plan=约定, praise=夸赞, vent=吐槽, joke=玩梗, boast=炫耀, flattery=吹捧, banter=调侃, perfunctory=敷衍, gossip=吃瓜, coquetry=撒娇, other=其他）；\n` +
      `emotion 只能是: ${Object.keys(EMOTION_LABELS).join(', ')}（neutral=平静, joy=开心, curiosity=好奇, excitement=兴奋, admiration=赞叹, affection=亲昵, sadness=低落, anger=生气, anxiety=焦虑, fatigue=疲惫, shock=震惊, aggrieved=委屈, irony=反讽, anticipation=期待, embarrassed=尴尬）；\n` +
      '重要语用准则：\n' +
      '0. 基线原则（最重要）：日常普通对话、客观陈述、简单应答（如「好的」「收到」「在干嘛」「原来如此」）优先判为 intent="chat" 或 "info" 或 "question"，emotion="neutral"（平静），intensity 20~45，sentiment -10~+30。切勿将普通对话过度解读为 boast（炫耀）、flattery（吹捧）或 admiration（赞叹）！只有措辞或语境确实强烈时才使用高强度标签。\n' +
      '1. 夸张式赞叹：若上文提到厉害的成果、作品、战绩或牛逼操作（且上下文新鲜有效），下文回复「吓哭了」「看傻了」「给跪了」「头皮发麻」「恐怖如斯」「太变态了」「怪物吧」「这是人能做出来的？」「卧槽」「逆天」「？？？」等，绝非恐惧/焦虑/悲伤，而是极度惊叹与佩服，必须判为 intent="praise", emotion="admiration", sentiment 为高正值（+75~+95）！\n' +
      '2. 程度副词化的「死/哭」：「笑死/笑哭/蚌埠住了」是玩梗+开心(joy)；「羡慕哭了/馋哭了」是夸赞+赞叹(admiration)；「感动哭了/泪目/awsl」是亲昵(affection)。\n' +
      '3. 反语、敷衍与阴阳怪气：「好好好/行行行/啊对对对/你开心就好/我真的会谢/栓Q」判为 intent="perfunctory" 或 "vent", emotion="irony" 或 "anger", sentiment<0。\n' +
      '4. 炫耀、吹捧、吃瓜、撒娇：明确秀战绩/晒抽卡/凡尔赛才判为 boast；狂吹大佬/捧哏才判为 flattery；尊嘟假嘟/求细说/蹲后续判为 gossip；求带/呜呜呜/贴贴判为 coquetry。\n' +
      'intensity 0-100（情绪强度），sentiment -100..100（消极到积极），confidence 0..1。' +
      '只输出 JSON：{"results":[{"i":序号,"intent":"...","emotion":"...","intensity":0,"sentiment":0,"confidence":0}]}，不要输出其它内容。';
    try {
      const body = await requestApiJson<{
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      }>({ ...endpoint, baseUrl, feature: 'intent-analysis' }, '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify({
          model: endpoint.model,
          temperature: this.config.analysisTemperature,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(this.config.apiTimeoutSeconds * 1000),
      });
      if (revision !== this.analysisRevision) return null;
      this.apiCooldownUntil = 0;
      this.lastApiError = null;
      const content = pickMessageText(body.choices?.[0]?.message);
      const parsed = extractJsonBlock(content) as { results?: unknown[] } | null;
      if (!parsed || !Array.isArray(parsed.results)) return [];
      const out: IntentSenseResult[] = [];
      for (const item of parsed.results) {
        const r = item as Record<string, unknown>;
        const i = Number(r.i);
        if (!Number.isInteger(i) || i < 0 || i >= batch.length) continue;
        const src = batch[i];
        if (!src) continue;
        const calibrated = calibrateIntentSense(
          {
            intent: normalizeIntent(r.intent),
            emotion: normalizeEmotion(r.emotion),
            intensity: clamp(Number(r.intensity ?? 50) || 0, 0, 100),
            sentiment: clamp(Number(r.sentiment ?? 0) || 0, -100, 100),
            confidence: clamp(Number(r.confidence ?? 0.5) || 0, 0, 1),
          },
          src.text,
          src.context,
          src.sendTime,
        );
        out.push({
          msgId: src.msgId,
          mine: src.mine,
          sendTime: src.sendTime,
          intent: calibrated.intent,
          emotion: calibrated.emotion,
          intensity: clamp(calibrated.intensity, 0, 100),
          sentiment: clamp(calibrated.sentiment, -100, 100),
          confidence: clamp(calibrated.confidence, 0, 1),
          engine: 'api',
          analyzedAt: Date.now(),
        });
      }
      return out;
    } catch (error) {
      if (revision !== this.analysisRevision) return null;
      this.apiCooldownUntil = Date.now() + this.config.apiCooldownSeconds * 1000;
      const errMsg = error instanceof Error ? error.message : String(error);
      const causeMsg =
        error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
      this.lastApiError = `${errMsg}${causeMsg}`;
      logger.warn('intent-sense api batch failed', {
        event: 'intent-sense-api-failed',
        ...logErrorContext(error),
      });
      return null;
    }
  }

  /** 兼容旧 IPC 入口；运行状态与计算由独立画像服务持有。 */
  getProfile(peerUid: string, options?: { cachedOnly?: boolean }): Promise<IntentProfile | null> {
    this.syncDefaultModels();
    const revision = this.profileRevision;
    return this.profileService.getProfile(peerUid, options).then((result) => {
      this.syncDefaultModels();
      if (revision !== this.profileRevision) throw new Error('默认画像模型已更改，请重新读取');
      return result;
    });
  }

  // ── 回复建议（API 引擎优先 + 本地意图候选兜底）─────────────────────────────

  private suggestionHistoryFor(kind: IntentConversationKind, conv: string) {
    const key = conversationKey(kind, conv);
    let store = this.suggestionHistoryStores.get(key);
    if (!store) {
      store = new JsonStore<ReplySuggestionHistoryEntry[]>(
        `${this.storeDir}/suggestion-history/${fileSafe(key)}.json`,
        () => [],
        {
          normalize: (raw) => {
            if (!Array.isArray(raw)) return [];
            return raw
              .filter((entry): entry is ReplySuggestionHistoryEntry => {
                if (!entry || typeof entry !== 'object') return false;
                const value = entry as Partial<ReplySuggestionHistoryEntry>;
                return (
                  typeof value.id === 'string' &&
                  typeof value.createdAt === 'number' &&
                  Number.isFinite(new Date(value.createdAt).getTime()) &&
                  typeof value.target?.msgId === 'string' &&
                  typeof value.target.sendTime === 'number' &&
                  Number.isFinite(new Date(value.target.sendTime * 1000).getTime()) &&
                  typeof value.target.senderUin === 'string' &&
                  (value.target.msgSeq === undefined || /^\d+$/.test(value.target.msgSeq)) &&
                  Array.isArray(value.suggestions) &&
                  value.suggestions.length > 0 &&
                  value.suggestions.every(
                    (item) =>
                      item &&
                      typeof item.text === 'string' &&
                      (item.tone === undefined || typeof item.tone === 'string'),
                  )
                );
              })
              .map((entry) => ({
                ...entry,
                summary:
                  typeof entry.summary === 'string' ? entry.summary.trim() || undefined : undefined,
                generation: normalizeSuggestionGeneration(entry.generation),
              }));
          },
        },
      );
      this.suggestionHistoryStores.set(key, store);
    }
    return store;
  }

  getSuggestionHistory(kind: IntentConversationKind, conv: string): ReplySuggestionHistoryEntry[] {
    return [...this.suggestionHistoryFor(kind, conv).data].reverse();
  }

  private suggestionTracePath(kind: IntentConversationKind, conv: string, id: string): string {
    return join(
      this.storeDir,
      'suggestion-details',
      fileSafe(conversationKey(kind, conv)),
      `${fileSafe(id)}.json`,
    );
  }

  getSuggestionDetails(
    kind: IntentConversationKind,
    conv: string,
    id?: string,
  ): ReplySuggestionDetails | null {
    this.syncDefaultModels();
    const key = conversationKey(kind, conv);
    const runtime = this.suggestionDetails.get(key);
    if (runtime && (!id || runtime.details.progress?.id === id)) {
      if (
        runtime.revision !== this.suggestionRevision &&
        runtime.details.progress?.status === 'running'
      )
        this.updateSuggestionProgress(
          runtime.details,
          'stopped',
          '本轮已失效',
          '推荐配置已更改，本轮不再生成。',
        );
      return runtime.details.progress?.status === 'running'
        ? { ...runtime.details, progress: { ...runtime.details.progress, updatedAt: Date.now() } }
        : runtime.details;
    }
    if (!id) return null;
    const current = this.suggestionCache.get(key);
    if (current && current.round.id === id)
      return { entry: current.round, trace: current.trace ?? null };
    const entry = this.suggestionHistoryFor(kind, conv).data.find((entry) => entry.id === id);
    if (!entry) return null;
    const raw = readJsonFile(this.suggestionTracePath(kind, conv, id));
    let trace: ReplySuggestionTrace | null = null;
    if (raw && typeof raw === 'object') {
      trace = {};
      if (
        'prompt' in raw &&
        raw.prompt &&
        typeof raw.prompt === 'object' &&
        'system' in raw.prompt &&
        'user' in raw.prompt &&
        typeof raw.prompt.system === 'string' &&
        typeof raw.prompt.user === 'string'
      )
        trace.prompt = { system: raw.prompt.system, user: raw.prompt.user };
      if ('response' in raw && typeof raw.response === 'string') trace.response = raw.response;
      if ('error' in raw && typeof raw.error === 'string') trace.error = raw.error;
      if ('logs' in raw && Array.isArray(raw.logs)) {
        trace.logs = raw.logs.filter(
          (line): line is NonNullable<ReplySuggestionTrace['logs']>[number] =>
            !!line &&
            typeof line === 'object' &&
            Number.isInteger(line.seq) &&
            line.seq > 0 &&
            typeof line.ts === 'number' &&
            Number.isFinite(new Date(line.ts).getTime()) &&
            typeof line.stage === 'string' &&
            typeof line.text === 'string' &&
            (line.level === 'info' || line.level === 'warn' || line.level === 'error'),
        );
      }
    }
    return { entry, trace };
  }

  private updateSuggestionProgress(
    details: ReplySuggestionDetails,
    status: NonNullable<ReplySuggestionDetails['progress']>['status'],
    stage: string,
    text = stage,
    level: 'info' | 'warn' | 'error' = 'info',
  ): void {
    if (!details.progress || !details.trace) return;
    details.progress = { ...details.progress, status, stage, updatedAt: Date.now() };
    details.trace.logs ??= [];
    const logs = details.trace.logs;
    logs.push({ seq: logs.length + 1, ts: details.progress.updatedAt, stage, level, text });
    if (details.entry?.generation)
      details.entry.generation.durationMs = details.progress.updatedAt - details.progress.startedAt;
  }

  getSuggestionRound(
    kind: IntentConversationKind,
    conv: string,
    options: { refresh?: boolean } = {},
  ): Promise<ReplySuggestionHistoryEntry | null> {
    const task = this.getSuggestions(kind, conv, options);
    return task.then(() => this.suggestionRounds.get(task)?.round ?? null);
  }

  private recordSuggestions(
    kind: IntentConversationKind,
    conv: string,
    last: SenseRow,
    suggestions: ReplySuggestion[],
    metadata: Pick<ReplySuggestionHistoryEntry, 'summary' | 'generation'>,
    trace?: ReplySuggestionTrace,
    id = randomUUID(),
  ): ReplySuggestionHistoryEntry | null {
    if (!suggestions.length) return null;
    const entry: ReplySuggestionHistoryEntry = {
      id,
      createdAt: Date.now(),
      target: {
        msgId: last.msgId,
        msgSeq: last.msgSeq,
        senderUin: last.senderUin,
        sendTime: last.sendTime,
      },
      suggestions,
      ...metadata,
    };
    const limit = this.config.suggestionHistoryLimit;
    if (limit === 0) return entry;
    const store = this.suggestionHistoryFor(kind, conv);
    const removed = store.data.slice(0, Math.max(0, store.data.length + 1 - limit));
    store.data = [...store.data, entry].slice(-limit);
    if (trace) writeJsonFileAtomic(this.suggestionTracePath(kind, conv, entry.id), trace);
    store.save();
    for (const old of removed) {
      try {
        unlinkSync(this.suggestionTracePath(kind, conv, old.id));
      } catch {}
    }
    return entry;
  }

  getSuggestions(
    kind: IntentConversationKind,
    conv: string,
    options: { refresh?: boolean } = {},
  ): Promise<ReplySuggestion[]> {
    this.syncDefaultModels();
    if (
      this.config.conversationOverrides[conversationKey(kind, conv)] === false ||
      !this.config.suggestionsEnabled ||
      (this.config.suggestionMode === 'manual' && options.refresh !== true)
    )
      return Promise.resolve([]);
    const revision = this.suggestionRevision;
    const manualRefresh = options.refresh === true;
    const key = conversationKey(kind, conv);
    const inFlightKey = `${key}:${revision}`;
    const running = this.suggestionInFlight.get(inFlightKey);
    if (running) return running;
    const controller = new AbortController();
    this.suggestionControllers.set(inFlightKey, controller);
    const result: { round?: ReplySuggestionHistoryEntry } = {};
    const id = randomUUID();
    const startedAt = Date.now();
    const details: ReplySuggestionDetails = {
      entry: null,
      trace: { logs: [] },
      progress: { id, status: 'running', stage: '读取输入', startedAt, updatedAt: startedAt },
    };
    this.suggestionDetails.set(key, { revision, details });
    const currentRevision = () =>
      revision === this.suggestionRevision && !controller.signal.aborted;
    const log = (stage: string, text = stage, level: 'info' | 'warn' | 'error' = 'info') =>
      this.updateSuggestionProgress(details, 'running', stage, text, level);
    const stop = () =>
      this.updateSuggestionProgress(details, 'stopped', '已停止', '本轮推荐已停止。');
    controller.signal.addEventListener('abort', stop, { once: true });
    log('读取输入', '正在读取本轮对话输入。');

    const task = (async (): Promise<ReplySuggestion[]> => {
      const started = performance.now();
      const contextMessages = this.config.suggestionContextMessages;
      const current = () => {
        this.syncDefaultModels();
        return (
          revision === this.suggestionRevision &&
          !controller.signal.aborted &&
          this.config.suggestionsEnabled &&
          this.config.conversationOverrides[key] !== false
        );
      };
      const rows = await this.loadMessages(kind, conv, contextMessages + 1);
      if (!current()) return [];
      if (rows.length === 0) return [];
      const last = rows[rows.length - 1] as SenseRow;
      if (last.mine && !this.config.suggestAfterSelf && !manualRefresh) {
        this.suggestionCache.delete(key);
        return [];
      }
      const cachedHit = this.suggestionCache.get(key);
      if (
        !manualRefresh &&
        cachedHit &&
        cachedHit.lastMsgId === last.msgId &&
        Date.now() - cachedHit.at < this.config.suggestionCacheSeconds * 1000
      ) {
        result.round = cachedHit.round;
        details.entry = cachedHit.round;
        details.trace = cachedHit.trace ?? null;
        // 缓存命中没有新轮次，仍打开实际结果的详情。
        details.progress = {
          ...details.progress!,
          status: 'completed',
          stage: '已复用缓存',
          updatedAt: Date.now(),
        };
        return cachedHit.round.suggestions;
      }

      const trace = details.trace!;
      details.entry = {
        id,
        createdAt: startedAt,
        target: {
          msgId: last.msgId,
          msgSeq: last.msgSeq,
          senderUin: last.senderUin,
          sendTime: last.sendTime,
        },
        suggestions: [],
      };
      log('准备请求', `已读取 ${rows.length} 条输入消息，正在准备推荐请求。`);
      let model: string | undefined;
      let providerId: string | undefined;
      let providerName: string | undefined;
      let requestDurationMs: number | undefined;
      let usage: ReturnType<typeof parseApiUsage> | undefined;
      const complete = (
        suggestions: ReplySuggestion[],
        source: 'api' | 'local' | 'fallback',
        summary?: string,
      ): ReplySuggestion[] => {
        if (!current()) return [];
        this.updateSuggestionProgress(
          details,
          'completed',
          '生成完成',
          `本轮生成完成，共 ${suggestions.length} 条候选。`,
        );
        const round = this.recordSuggestions(
          kind,
          conv,
          last,
          suggestions,
          {
            summary,
            generation: {
              source,
              model,
              providerId,
              providerName,
              startedAt,
              durationMs: Math.round(performance.now() - started),
              requestDurationMs,
              inputMessages: rows.length,
              usage,
            },
          },
          trace,
          id,
        );
        if (round) {
          details.entry = round;
          result.round = round;
          this.suggestionCache.set(key, {
            lastMsgId: last.msgId,
            at: round.createdAt,
            round,
            trace,
          });
        }
        return suggestions;
      };

      const fallbackLocal = (): ReplySuggestion[] => {
        if (!current()) return [];
        if (trace.error) log('请求错误 / 回退原因', trace.error, 'error');
        if (!this.config.suggestionFallbackEnabled) {
          this.updateSuggestionProgress(
            details,
            'failed',
            '未生成候选',
            trace.error ?? '未启用回退内容。',
            'warn',
          );
          return [];
        }
        const suggestions = sampleSuggestionFallback(
          this.config.suggestionFallbackTexts,
          this.config.suggestionCount,
        ).map((text) => ({ text }));
        if (!suggestions.length) {
          this.updateSuggestionProgress(details, 'failed', '未生成候选', '回退内容为空。', 'warn');
          return [];
        }
        log('本地候选', '正在选择本地回退内容。');
        return complete(suggestions, trace.prompt || trace.error ? 'fallback' : 'local');
      };

      const endpoint = this.endpoint(this.config.suggestionProviderRef);
      model = endpoint?.model;
      providerId =
        endpoint?.providerId ??
        (this.config.suggestionProviderRef && 'providerId' in this.config.suggestionProviderRef
          ? this.config.suggestionProviderRef.providerId
          : undefined);
      providerName = endpoint?.providerName;
      details.entry.generation = {
        source: endpoint ? 'api' : 'local',
        model,
        providerId,
        providerName,
        startedAt,
        durationMs: 0,
        inputMessages: rows.length,
      };
      if (!endpoint || Date.now() < this.suggestionApiCooldownUntil) {
        if (endpoint) trace.error = '模型服务处于失败冷却期，本轮使用本地候选。';
        return fallbackLocal();
      }
      const baseUrl = endpoint.baseUrl.replace(/\/+$/, '');

      log('准备上下文', '正在补全发送者与提及对象资料。');
      const people = await this.suggestionPeople(kind, conv, rows);
      if (!current()) return [];
      const prompt = buildSuggestionPrompt({
        kind,
        rows,
        people,
        self: { uid: this.session.selfUid, uin: this.session.context.uin?.toString() },
        now: Date.now() / 1000,
        count: this.config.suggestionCount,
        targetChars: this.config.suggestionTargetChars,
      });
      trace.prompt = prompt;
      log('System Prompt', `System Prompt\n${prompt.system}`);
      log('User Prompt', `User Prompt\n${prompt.user}`);
      log('等待模型返回', `已发送推荐请求，等待模型 ${model} 返回。`);
      const requestStarted = performance.now();
      try {
        const body = await requestApiJson<{
          model?: string;
          choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
        }>({ ...endpoint, baseUrl, feature: 'reply-suggestion' }, '/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${endpoint.apiKey}`,
          },
          body: JSON.stringify({
            model: endpoint.model,
            temperature: this.config.suggestionTemperature,
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
          }),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(this.config.apiTimeoutSeconds * 1000),
          ]),
        });
        if (!current()) return [];
        requestDurationMs = Math.round(performance.now() - requestStarted);
        if (details.entry?.generation)
          details.entry.generation.requestDurationMs = requestDurationMs;
        trace.response = JSON.stringify(body);
        log('原始返回', `原始返回\n${trace.response}`);
        if (typeof body.model === 'string' && body.model.trim()) model = body.model;
        usage = parseApiUsage(body);
        this.lastSuggestionApiError = null;
        const parsed = extractJsonBlock(pickMessageText(body.choices?.[0]?.message)) as {
          summary?: unknown;
          replies?: unknown[];
        } | null;
        const suggestions: ReplySuggestion[] = (parsed?.replies ?? [])
          .map((r): ReplySuggestion | null => {
            if (typeof r === 'string') return { text: r };
            const o = r as { text?: unknown; tone?: unknown } | null;
            if (!o || typeof o.text !== 'string' || !o.text) return null;
            return { text: o.text, tone: typeof o.tone === 'string' ? o.tone : undefined };
          })
          .filter((r): r is ReplySuggestion => r !== null)
          .slice(0, this.config.suggestionCount);
        if (suggestions.length === 0) {
          trace.error = '模型未返回有效候选，本轮使用本地候选。';
          return fallbackLocal();
        }
        return complete(
          suggestions,
          'api',
          typeof parsed?.summary === 'string' ? parsed.summary.trim() || undefined : undefined,
        );
      } catch (error) {
        if (!current()) return [];
        requestDurationMs = Math.round(performance.now() - requestStarted);
        if (details.entry?.generation)
          details.entry.generation.requestDurationMs = requestDurationMs;
        trace.error = error instanceof Error ? error.message : String(error);
        this.suggestionApiCooldownUntil = Date.now() + this.config.apiCooldownSeconds * 1000;
        this.lastSuggestionApiError = error instanceof Error ? error.message : String(error);
        logger.debug('intent-sense suggestions failed', {
          event: 'intent-sense-suggestions-failed',
          ...logErrorContext(error),
        });
        return fallbackLocal();
      }
    })()
      .catch((error: unknown) => {
        if (currentRevision() && details.progress?.status !== 'stopped') {
          if (details.trace)
            details.trace.error = error instanceof Error ? error.message : String(error);
          this.updateSuggestionProgress(
            details,
            'failed',
            '生成失败',
            details.trace?.error,
            'error',
          );
        }
        throw error;
      })
      .finally(() => {
        controller.signal.removeEventListener('abort', stop);
        if (details.progress?.status === 'running')
          this.updateSuggestionProgress(
            details,
            currentRevision() ? 'completed' : 'stopped',
            currentRevision() ? '未生成候选' : '本轮已失效',
          );
        if (this.suggestionInFlight.get(inFlightKey) === task) {
          this.suggestionInFlight.delete(inFlightKey);
        }
        if (this.suggestionControllers.get(inFlightKey) === controller)
          this.suggestionControllers.delete(inFlightKey);
      });

    this.suggestionInFlight.set(inFlightKey, task);
    this.suggestionRounds.set(task, result);
    return task;
  }

  /** 仅停止当前会话的在途推荐，不改变自动推荐开关或已有候选。 */
  stopSuggestions(kind: IntentConversationKind, conv: string): boolean {
    const prefix = `${conversationKey(kind, conv)}:`;
    let stopped = false;
    for (const [key, controller] of this.suggestionControllers) {
      if (!key.startsWith(prefix)) continue;
      controller.abort();
      this.suggestionControllers.delete(key);
      this.suggestionInFlight.delete(key);
      stopped = true;
    }
    return stopped;
  }

  // ── 消息读取（内部）─────────────────────────────────────────────────────

  /** 只查这批消息及 @ 涉及的本地资料，缺失时仍以消息自带身份生成上下文。 */
  private async suggestionPeople(
    kind: IntentConversationKind,
    conv: string,
    rows: readonly SenseRow[],
  ): Promise<SuggestionPerson[]> {
    const mentions = rows.flatMap((row) => suggestionMentions(row.elementsRaw));
    const uids = [
      ...new Set(
        [
          this.session.selfUid,
          ...rows.map((row) => row.senderUid),
          ...mentions.map((mention) => mention.uid),
        ].filter((uid): uid is string => Boolean(uid)),
      ),
    ];
    const uins = [
      ...new Set(
        [
          this.session.context.uin?.toString(),
          ...rows.map((row) => row.senderUin),
          ...mentions.map((mention) => mention.uin),
        ].filter((uin): uin is string => Boolean(uin && /^[1-9]\d*$/.test(uin))),
      ),
    ];
    const people: SuggestionPerson[] = [];
    try {
      const profiles = (await this.session.profileInfo?.profilesByUids(uids)) ?? [];
      people.push(
        ...profiles.map((p) => ({ uid: p.uid, uin: String(p.uin), name: p.remark || p.nick })),
      );
    } catch (error) {
      logger.debug('intent-sense suggestion profile lookup failed', logErrorContext(error));
    }
    if (kind === 'group') {
      const lookups = [
        () => this.session.groupMembers?.getMembersByUids(BigInt(conv), uids),
        () => this.session.groupMembers?.getMembersByUins(BigInt(conv), uins.map(BigInt)),
      ];
      const groups = await Promise.all(
        lookups.map(async (lookup) => {
          try {
            return (await lookup()) ?? [];
          } catch (error) {
            logger.debug('intent-sense suggestion member lookup failed', logErrorContext(error));
            return [];
          }
        }),
      );
      for (const members of groups)
        people.push(
          ...members.map((p) => ({
            uid: p.uid,
            uin: String(p.uin),
            name: p.card || p.nick,
          })),
        );
    }
    return people;
  }

  /** 读最近 limit 条（或指定 msgId 集），返回时间升序、带分析文本与 mine 标记的行。 */
  private async loadMessages(
    kind: IntentConversationKind,
    conv: string,
    limit: number,
    onlyMsgIds?: string[],
    beforeSeq?: bigint,
  ): Promise<SenseRow[]> {
    const toRow = (m: C2cMsg | GroupMsg): SenseRow => {
      const mine =
        kind === 'c2c'
          ? (m as C2cMsg).senderUid !== conv // c2c：非对方即自己（buddy_analytics 同款判定）
          : String((m as GroupMsg).senderUin) === String(this.session.context.uin ?? '');
      return {
        msgId: m.msgId.toString(),
        msgSeq: m.msgSeq.toString(),
        mine,
        senderUid: m.senderUid,
        senderUin: m.senderUin.toString(),
        sendTime: Number(m.sendTime),
        text: elementsToSenseText(m.elements),
        elementsRaw: m.elements,
      };
    };
    const toRoamingRow = (message: GapFetchedMessage): SenseTimelineRow => {
      const elements = message.elements.map(
        (element): SenseElement => ({
          kind: element.type,
          ...(element.type === 'text' || element.type === 'at'
            ? {
                textContent: element.data.textContent,
                ...(element.type === 'at' ? { atTargetUid: element.data.atTargetUid } : {}),
              }
            : {}),
          ...(element.type === 'face' ? { faceText: element.data.faceText } : {}),
        }),
      );
      return {
        ...message,
        source: 'roaming',
        sense: {
          msgId: timelineRowKey({ ...message, source: 'roaming' }),
          msgSeq: message.msgSeq,
          mine:
            kind === 'c2c'
              ? message.senderUid !== conv
              : message.senderUin === String(this.session.context.uin ?? ''),
          senderUid: message.senderUid,
          senderUin: message.senderUin,
          sendTime: Number(message.sendTime),
          text: elementsToSenseText(elements),
          elementsRaw: elements,
        },
      };
    };
    const cached = async (start: number, end: number, count: number) => {
      if (!this.opts.gapHistory) return [];
      try {
        const rows = await this.opts.gapHistory.cachedTimeline(kind, conv, start, end, count, true);
        return rows
          .filter((message) => message.kind === kind && message.conv === conv)
          .map(toRoamingRow);
      } catch (error) {
        logger.debug('intent-sense roaming cache read failed', {
          event: 'intent-sense-roaming-cache-failed',
          ...logErrorContext(error),
        });
        return [];
      }
    };
    if (onlyMsgIds) {
      const ids = onlyMsgIds.map((id) => {
        try {
          return BigInt(id);
        } catch {
          return null;
        }
      });
      const valid = ids.filter((b): b is bigint => b !== null);
      const found =
        valid.length === 0
          ? []
          : kind === 'c2c'
            ? await this.session.c2cMsgs.listByMsgIds(valid)
            : await this.session.groupMsgs.listByMsgIds(valid);
      const result = found.map(toRow);
      for (const msgId of onlyMsgIds) {
        const match = /^roaming:(?:(?:native|protocol):)?([1-9]\d{0,9}):(-?\d{1,20})$/.exec(msgId);
        if (!match || Number(match[1]) > 0xffffffff) continue;
        const seq = Number(match[1]);
        const messages = mergeRoamingTimeline(kind, [], await cached(seq, seq, 2000));
        const message = messages.find((message) => message.sense.msgId === msgId);
        if (message) result.push(message.sense);
      }
      return result;
    }
    const msgs =
      kind === 'c2c'
        ? beforeSeq === undefined
          ? await this.session.c2cMsgs.listLatest(this.c2cPartition(conv), limit)
          : await this.session.c2cMsgs.listBefore(this.c2cPartition(conv), beforeSeq, limit)
        : beforeSeq === undefined
          ? await this.session.groupMsgs.listLatest(conv, limit)
          : await this.session.groupMsgs.listBefore(conv, beforeSeq, limit);
    if (!this.opts.gapHistory) return msgs.map(toRow).reverse();
    const local: SenseTimelineRow[] = msgs.map((message) => ({
      msgId: message.msgId.toString(),
      msgSeq: message.msgSeq.toString(),
      msgRandom: message.msgRandom?.toString(),
      senderUid: message.senderUid,
      sendTime: message.sendTime.toString(),
      sense: toRow(message),
    }));
    const max = beforeSeq === undefined ? 0xffffffff : Number(beforeSeq - 1n);
    const roaming = await cached(1, Math.min(max, 0xffffffff), limit);
    return mergeRoamingTimeline(kind, local, roaming, { descending: true, limit })
      .reverse()
      .map((message) => message.sense);
  }

  private c2cPartition(peerUid: string): C2cPartition {
    const sortNo = this.session.uidMap.sortNoByUid(peerUid);
    return sortNo !== undefined ? { sortNo } : { uid: peerUid };
  }

  private cacheFor(kind: IntentConversationKind, conv: string): JsonStore<CacheFile> {
    this.syncDefaultModels();
    const modelIdentity = this.analysisModelIdentity();
    const key = conversationKey(kind, conv);
    const existing = this.analysisStores.get(key);
    if (existing) return existing;
    const store = new JsonStore<CacheFile>(
      `${this.storeDir}/analysis/${fileSafe(key)}.json`,
      () => ({
        version: CACHE_SCHEMA_VERSION,
        contextMessages: this.config.analysisContextMessages,
        modelIdentity,
        results: [],
      }),
      {
        normalize: (raw) => {
          const file = normalizeCacheFile(raw, this.config.analysisContextMessages, modelIdentity);
          return { ...file, results: file.results.slice(-this.config.cacheEntries) };
        },
      },
    );
    this.analysisStores.set(key, store);
    return store;
  }

  /** 合并内存缓存并裁剪到上限；本地批次可推迟到块结束再统一落盘。 */
  private storeResults(
    kind: IntentConversationKind,
    conv: string,
    results: IntentSenseResult[],
    { persist = true }: { persist?: boolean } = {},
  ): void {
    const store = this.cacheFor(kind, conv);
    const merged = new Map(store.data.results.map((r) => [r.msgId, r]));
    for (const r of results) merged.set(r.msgId, r);
    let all = [...merged.values()];
    if (all.length > this.config.cacheEntries) {
      all = [...all]
        .sort((a, b) => a.sendTime - b.sendTime)
        .slice(all.length - this.config.cacheEntries);
    }
    store.data = {
      version: CACHE_SCHEMA_VERSION,
      contextMessages: this.config.analysisContextMessages,
      modelIdentity: this.analysisModelIdentity(),
      results: all,
    };
    if (persist) store.save();
  }
}

/** 内部读取行（loadMessages 的产物）。 */
type SenseRow = SuggestionMessage;

interface SenseTimelineRow extends TimelineRow {
  sense: SenseRow;
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

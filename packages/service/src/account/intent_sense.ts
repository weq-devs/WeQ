/**
 * IntentSenseService — 意图感知：逐条分析聊天消息的意图/情绪，并聚合出
 * 对方的互动画像（好感度 / MBTI 倾向 / 互动风格雷达 / 常见话题）。
 *
 * 三层结构：
 *   • 配置（per account，JsonStore）：总开关、引擎选择（api | local）、API provider
 *     引用、回复建议开关、按会话覆盖。存储模式对齐 {@link AntiRecallService}。
 *   • 分析缓存（per conversation，惰性 JsonStore）：`msgId → 分析结果`，增量补分析
 *     （ensureAnalysis 只跑缓存里没有的消息），上限 {@link CACHE_MAX_ENTRIES} 条，
 *     按发送时间裁剪最旧的。
 *   • 引擎：`api` = OpenAI 兼容结构化 JSON 调用（复用注入的 EndpointResolver，与
 *     助手/克隆体同一套 provider 配置）；`local` = 注入的 {@link IntentLocalEnginePort}
 *     （桌面版 utilityProcess 里的 Laya ONNX worker；web 版没有，保持 null）。
 *     API 引擎生成回复建议；本地或 API 不可用时使用本地意图候选，Laya 不生成自由文本。
 *
 * 画像聚合（getProfile）以本地统计为主（消息节奏 / 发起比 / 回复延迟 / 分词话题，
 * 思路同 BuddyAnalyticsService），引擎结果（逐条情绪、MBTI 维度提示）作增强；
 * 引擎不可用时全部退化为启发式估算，UI 需标注「仅供娱乐参考」。
 *
 * Renderer 驱动：intentSense tRPC router（getStatus / setConfig / ensureAnalysis /
 * getMessageAnalyses / analyzeMessage / getProfile / getSuggestions / onAnalyzed）。
 */

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { C2cMsg, C2cPartition, GroupMsg } from '@weq/db';
import type { Element } from '@weq/codec';
import {
  pickMessageText,
  reportUsage,
  type AgentLabEndpoint,
  type AgentLabModelRef,
} from '@weq/agentlab';
import type { EndpointResolver } from './assistant';
import { JsonStore } from '../common/json_store';
import { segmentWords } from './text_segment';
import { analyzePragmatics, calibrateIntentSense, type IntentContextTurn } from './intent_corpus';
import { getLogger, logErrorContext } from '../common/logger';
import {
  DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
  DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
  MAX_INTENT_CONTEXT_MESSAGES,
  isIntentContextCount,
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

export interface IntentSenseConfig {
  /** 总开关。 */
  enabled: boolean;
  /** 引擎：api（OpenAI 兼容）| local（Laya ONNX worker）。 */
  engine: 'api' | 'local';
  /** api 引擎用的 provider 引用（与 agentlab provider 目录同一套）。 */
  providerRef: AgentLabModelRef | null;
  /** 回复建议开关（仅 api 引擎有效）。 */
  suggestionsEnabled: boolean;
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
  /** resolveEndpoint + providerRef 都就绪，api 引擎可用。 */
  apiConfigured: boolean;
  /** local 引擎端口已注入（桌面版有，web 版没有）。 */
  localAvailable: boolean;
  /** local 引擎 worker 已启动且模型加载完成（分析真正可跑）。 */
  localReady: boolean;
  /** 最近一次 API 引擎调用失败原因（成功或切换配置后置 null）。 */
  lastApiError?: string | null;
}

const DEFAULT_CONFIG: IntentSenseConfig = {
  enabled: false,
  engine: 'api',
  providerRef: null,
  suggestionsEnabled: false,
  analysisContextMessages: DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
  suggestionContextMessages: DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
  hfMirror: true,
  conversationOverrides: {},
};

// ── 画像 ────────────────────────────────────────────────────────────────────

export interface MbtiDim {
  key: 'EI' | 'SN' | 'TF' | 'JP';
  /** 左侧极（E/S/T/J）的占比 0-100。 */
  leftPct: number;
}

export interface IntentProfile {
  /** 好感度 0-100（启发式综合，非客观事实）。 */
  affinity: number;
  /** 好感度档位 0-4（初识/熟络/亲近/挚友/羁绊）。 */
  tier: number;
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
  mbti?: MbtiDim[];
  radar?: Array<{ axis: string; value: number }>;
  topics?: string[];
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

/** onAnalyzed 事件：一批新分析结果落缓存后推给 renderer（增量点亮胶囊）。 */
export interface IntentAnalyzedEvent {
  kind: IntentConversationKind;
  conv: string;
  results: IntentSenseResult[];
}

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 单会话缓存上限（按 sendTime 裁最旧）。 */
const CACHE_MAX_ENTRIES = 2000;
/** 缓存 schema 版本：升级语料库/分类体系后自动淘汰旧版无上下文缓存。 */
const CACHE_SCHEMA_VERSION = 5;
/** ensureAnalysis 默认回看窗口。 */
const DEFAULT_WINDOW = 300;
/** 单次相邻消息最大允许间隔（秒）：超过 8 分钟视为对话暂停/断档，切断前序上下文。 */
const CONTEXT_MAX_ADJACENT_GAP_SEC = 8 * 60;
/** 上下文最大追溯总跨度（秒）：超过 15 分钟的陈旧消息不再作为当前句的因果背景。 */
const CONTEXT_MAX_TOTAL_SPAN_SEC = 15 * 60;
/** api 引擎每批消息数（一次结构化调用，控制在 12 条以内以降低推理模型超时率）。 */
const API_BATCH = 12;
/** 画像聚合最多扫描的消息数。 */
const PROFILE_WINDOW = 800;
/** 回复建议缓存：同一最后一条消息 90s 内不重发请求。 */
const SUGGESTION_TTL_MS = 90_000;

const MBTI_AXIS_LABELS: Record<MbtiDim['key'], [string, string]> = {
  EI: ['外向 E', '内向 I'],
  SN: ['实感 S', '直觉 N'],
  TF: ['思考 T', '情感 F'],
  JP: ['判断 J', '感知 P'],
};

const RADAR_AXES = ['主动性', '回应速度', '情绪外露', '话题广度', '正式度'] as const;

function conversationKey(kind: IntentConversationKind, id: string): string {
  return `${kind}:${id}`;
}

/** 文件名安全的会话键（uid 带 `u_`，群号纯数字，本来就行；兜底替换）。 */
function fileSafe(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 消息 → 供分析的文本：text + face 段；纯媒体消息返回 ''（不做分析）。 */
function elementsToSenseText(elements: Element[]): string {
  const parts: string[] = [];
  for (const el of elements) {
    if (el.kind === 'text') {
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

/** 从模型回复里抠出第一段 JSON（容忍 ```json 围栏与前后闲话）。 */
function extractJsonBlock(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw: string = fenced?.[1] ?? text;
  const starts = [raw.indexOf('['), raw.indexOf('{')].filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const open = raw[start] as '[' | '{';
  const close = open === '[' ? ']' : '}';
  const end = raw.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 按配置提取目标之前的紧邻上文，严格遵守时效性窗口。 */
function extractContextBefore(
  rows: readonly SenseRow[],
  targetIndex: number,
  maxMessages: number,
): IntentContextTurn[] {
  const target = rows[targetIndex];
  if (!target || targetIndex <= 0) return [];
  const picked: IntentContextTurn[] = [];
  let nextTime = target.sendTime;
  for (let i = targetIndex - 1; i >= 0 && picked.length < maxMessages; i--) {
    const prev = rows[i];
    if (!prev?.text) continue;
    // 时效性检查：相邻消息间隔不能超过 8 分钟，且距离目标消息总跨度不能超过 15 分钟
    if (nextTime > 0 && prev.sendTime > 0) {
      const stepGap = nextTime - prev.sendTime;
      const totalSpan = target.sendTime - prev.sendTime;
      if (
        stepGap > CONTEXT_MAX_ADJACENT_GAP_SEC ||
        totalSpan > CONTEXT_MAX_TOTAL_SPAN_SEC ||
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
            Math.min(1, 1 - (target.sendTime - prev.sendTime) / CONTEXT_MAX_TOTAL_SPAN_SEC),
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
  results: IntentSenseResult[];
}

function normalizeCacheFile(raw: unknown, contextMessages: number): CacheFile {
  const obj = raw as { version?: unknown; results?: unknown; contextMessages?: unknown } | null;
  const empty = { version: CACHE_SCHEMA_VERSION, contextMessages, results: [] };
  if (obj?.version !== CACHE_SCHEMA_VERSION || obj.contextMessages !== contextMessages)
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
  return { version: CACHE_SCHEMA_VERSION, contextMessages, results };
}

export interface IntentSenseOptions {
  /** api 引擎端点解析（与 AssistantService 同源的注入）。 */
  resolveEndpoint?: EndpointResolver;
  /** local 引擎端口（桌面版 utilityProcess 桥；web 版缺省 null）。 */
  localEngine?: IntentLocalEnginePort | null;
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

/** API 连续失败后的熔断冷却时间（毫秒），避免网络不通时连发 15 批请求刷屏报错。 */
const API_COOLDOWN_MS = 30_000;
/** API 单次请求超时（毫秒）。 */
const API_TIMEOUT_MS = 30_000;

export class IntentSenseService {
  private analysisRevision = 0;
  private suggestionRevision = 0;
  private readonly configStore: JsonStore<IntentSenseConfig>;
  private readonly analysisStores = new Map<string, JsonStore<CacheFile>>();
  /** 每会话在途 ensureAnalysis（去重并发）。 */
  private readonly inFlight = new Map<string, Promise<EnsureStats>>();
  private readonly analyzedListeners = new Set<(e: IntentAnalyzedEvent) => void>();
  /** 回复建议缓存 `${kind}:${conv}` → { lastMsgId, at, suggestions }。 */
  private readonly suggestionCache = new Map<
    string,
    { lastMsgId: string; at: number; suggestions: ReplySuggestion[] }
  >();
  /** API 熔断截止时间戳（ms）：网络/服务报错后短时间内不再重复撞墙。 */
  private apiCooldownUntil = 0;
  /** 最近一次 API 请求失败信息（供设置面板提示用户排查网络/Provider）。 */
  private lastApiError: string | null = null;

  constructor(
    private readonly session: AccountSession,
    private readonly storeDir: string,
    private readonly opts: IntentSenseOptions = {},
  ) {
    this.configStore = new JsonStore(`${storeDir}/config.json`, () => ({ ...DEFAULT_CONFIG }), {
      normalize: (raw) => {
        const p = (raw ?? {}) as Partial<IntentSenseConfig>;
        const ref = p.providerRef as AgentLabModelRef | null | undefined;
        return {
          enabled: p.enabled === true,
          engine: p.engine === 'local' ? 'local' : 'api',
          providerRef:
            ref && typeof ref.providerId === 'string' && typeof ref.model === 'string'
              ? { providerId: ref.providerId, model: ref.model }
              : null,
          suggestionsEnabled: p.suggestionsEnabled === true,
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
  }

  // ── 配置与状态 ───────────────────────────────────────────────────────────

  private get config(): IntentSenseConfig {
    return this.configStore.data;
  }

  getStatus(): IntentSenseStatus {
    return {
      ...this.config,
      analysisRevision: this.analysisRevision,
      suggestionRevision: this.suggestionRevision,
      apiConfigured: !!this.opts.resolveEndpoint && !!this.config.providerRef,
      localAvailable: !!this.opts.localEngine,
      localReady: !!this.opts.localEngine?.ready,
      lastApiError: this.lastApiError,
    };
  }

  async setConfig(
    patch: Partial<Omit<IntentSenseConfig, 'conversationOverrides'>>,
  ): Promise<IntentSenseStatus> {
    const next: IntentSenseConfig = { ...this.config };
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (patch.engine === 'api' || patch.engine === 'local') next.engine = patch.engine;
    if (patch.providerRef !== undefined) {
      next.providerRef =
        patch.providerRef?.providerId && patch.providerRef.model ? { ...patch.providerRef } : null;
    }
    if (typeof patch.suggestionsEnabled === 'boolean') {
      next.suggestionsEnabled = patch.suggestionsEnabled;
    }
    if (typeof patch.hfMirror === 'boolean') next.hfMirror = patch.hfMirror;
    for (const key of ['analysisContextMessages', 'suggestionContextMessages'] as const) {
      if (patch[key] === undefined) continue;
      if (!isIntentContextCount(patch[key]))
        throw new Error(`上文条数必须是 0–${MAX_INTENT_CONTEXT_MESSAGES} 的整数`);
      next[key] = patch[key];
    }
    const analysisChanged = next.analysisContextMessages !== this.config.analysisContextMessages;
    if (analysisChanged) {
      this.analysisRevision++;
      this.analysisStores.clear();
    }
    if (
      analysisChanged ||
      next.suggestionContextMessages !== this.config.suggestionContextMessages
    ) {
      this.suggestionRevision++;
      this.suggestionCache.clear();
    }
    this.apiCooldownUntil = 0;
    this.lastApiError = null;
    this.configStore.data = next;
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
        results: [],
      };
      store.save();
    }
    this.analysisStores.clear();
    this.suggestionCache.clear();
    this.apiCooldownUntil = 0;
    this.lastApiError = null;
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
    if (!this.config.enabled) return false;
    const override = this.config.conversationOverrides[conversationKey(kind, id)];
    if (override === false) return false;
    if (this.config.engine === 'local') return !!this.opts.localEngine?.ready;
    return !!this.opts.resolveEndpoint && !!this.config.providerRef;
  }

  // ── 事件 ─────────────────────────────────────────────────────────────────

  /** 订阅增量分析结果；返回退订函数（tRPC subscription 包装它）。 */
  onAnalyzed(cb: (e: IntentAnalyzedEvent) => void): () => void {
    this.analyzedListeners.add(cb);
    return () => {
      this.analyzedListeners.delete(cb);
    };
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
    limit = DEFAULT_WINDOW,
  ): Promise<EnsureStats> {
    if (!this.effectiveFor(kind, conv)) {
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
  ): Promise<IntentSenseResult | null> {
    if (!this.effectiveFor(kind, conv)) return null;
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
      context = extractContextBefore(recent, idx, contextMessages);
    } else {
      const rows = await this.loadMessages(kind, conv, 1, [msgId]);
      row = rows[0];
    }
    if (!row?.text) return null;
    if (revision !== this.analysisRevision) return null;

    let result: IntentSenseResult | null = null;
    if (this.config.engine === 'local') {
      result = await this.analyzeOne(row.mine, row.sendTime, row.msgId, row.text, context);
    } else {
      const batchOut = await this.analyzeBatchViaApi([{ ...row, context }]);
      if (revision !== this.analysisRevision) return null;
      if (batchOut !== null) {
        result = batchOut[0] ?? null;
      } else if (this.opts.localEngine?.ready) {
        result = await this.analyzeOne(row.mine, row.sendTime, row.msgId, row.text, context);
      }
    }
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
    const current = () => revision === this.analysisRevision;
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
    const startIndex = Math.max(0, rows.length - limit);
    const pending: Array<{ row: SenseRow; context: IntentContextTurn[] }> = [];
    for (let idx = startIndex; idx < rows.length; idx++) {
      const r = rows[idx]!;
      if (!known.has(r.msgId) && r.text) {
        pending.push({ row: r, context: extractContextBefore(rows, idx, contextMessages) });
      }
    }
    let analyzed = 0;
    let peerAnalyzed = 0;
    let failed = 0;
    if (pending.length > 0) {
      // 按最新分块优先处理（块内保持时间升序），确保用户首屏看到的最新消息最先点亮
      const chunks: Array<Array<{ row: SenseRow; context: IntentContextTurn[] }>> = [];
      for (let end = pending.length; end > 0; end -= API_BATCH) {
        const start = Math.max(0, end - API_BATCH);
        chunks.push(pending.slice(start, end));
      }

      const runChunkLocal = async (
        slice: Array<{ row: SenseRow; context: IntentContextTurn[] }>,
      ): Promise<void> => {
        const chunkResults: IntentSenseResult[] = [];
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
            chunkResults.push(result);
            analyzed++;
            if (!result.mine) peerAnalyzed++;
          } else {
            failed++;
          }
        }
        if (current() && chunkResults.length > 0) {
          this.storeResults(kind, conv, chunkResults);
          this.emitAnalyzed({ kind, conv, results: chunkResults });
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
          const batchInput = slice.map(({ row, context }) => ({
            msgId: row.msgId,
            mine: row.mine,
            sendTime: row.sendTime,
            text: row.text,
            context,
          }));
          const results = await this.analyzeBatchViaApi(batchInput);
          if (!current()) break;
          if (results === null) {
            // API 发生网络故障或处于熔断冷却：若本地引擎就绪则无缝降级本地引擎，否则立即中止后续批次避免刷屏报错
            if (this.opts.localEngine?.ready) {
              await runChunkLocal(slice);
              continue;
            }
            const remaining = chunks.slice(cIdx).reduce((acc, s) => acc + s.length, 0);
            failed += remaining;
            break;
          }
          if (results.length > 0) {
            this.storeResults(kind, conv, results);
            this.emitAnalyzed({ kind, conv, results });
          }
          analyzed += results.length;
          peerAnalyzed += results.filter((result) => !result.mine).length;
          failed += slice.length - results.length;
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

  private endpoint(): AgentLabEndpoint | null {
    if (!this.opts.resolveEndpoint || !this.config.providerRef) return null;
    try {
      return this.opts.resolveEndpoint(this.config.providerRef);
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
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify({
          model: endpoint.model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      };
      reportUsage(endpoint, body);
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
      this.apiCooldownUntil = Date.now() + API_COOLDOWN_MS;
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

  /** 引擎侧画像提示（api：一次结构化推断；local：inferMbti）。 */
  private async inferHints(peerTexts: string[]): Promise<ProfileHints | null> {
    if (peerTexts.length === 0) return null;
    const tryLocalHints = async (): Promise<ProfileHints | null> => {
      const port = this.opts.localEngine;
      if (!port?.ready) return null;
      try {
        const dims = await port.inferMbti(peerTexts.slice(-120));
        return dims ? { mbti: dims } : null;
      } catch {
        return null;
      }
    };
    if (this.config.engine === 'local') {
      return tryLocalHints();
    }
    const endpoint = this.endpoint();
    if (!endpoint || Date.now() < this.apiCooldownUntil) {
      return tryLocalHints();
    }
    const baseUrl = endpoint.baseUrl.replace(/\/+$/, '');
    const sample = peerTexts
      .slice(-120)
      .map((t, i) => `${i}. ${t}`)
      .join('\n');
    const system =
      '以下是一个人在私聊里的消息样本。基于这些消息推断其互动风格。只输出 JSON：' +
      '{"mbti":[{"key":"EI","leftPct":50},{"key":"SN","leftPct":50},{"key":"TF","leftPct":50},{"key":"JP","leftPct":50}],' +
      '"radar":[{"axis":"主动性","value":50},{"axis":"回应速度","value":50},{"axis":"情绪外露","value":50},{"axis":"话题广度","value":50},{"axis":"正式度","value":50}],' +
      '"topics":["话题词"]}（topics 最多 8 个）。' +
      'leftPct 是左侧极（E/S/T/J）占比 0-100；radar value 0-100。不要输出其它内容。';
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify({
          model: endpoint.model,
          temperature: 0.3,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: sample },
          ],
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.apiCooldownUntil = Date.now() + API_COOLDOWN_MS;
        return tryLocalHints();
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      };
      reportUsage(endpoint, body);
      const parsed = extractJsonBlock(
        pickMessageText(body.choices?.[0]?.message),
      ) as ProfileHints | null;
      if (!parsed || typeof parsed !== 'object') return null;
      const hints: ProfileHints = {};
      if (Array.isArray(parsed.mbti)) {
        hints.mbti = parsed.mbti
          .filter(
            (d): d is MbtiDim =>
              !!d &&
              typeof d === 'object' &&
              (d as MbtiDim).key in MBTI_AXIS_LABELS &&
              typeof (d as MbtiDim).leftPct === 'number',
          )
          .map((d) => ({ key: d.key, leftPct: clamp(d.leftPct, 0, 100) }));
      }
      if (Array.isArray(parsed.radar)) {
        hints.radar = parsed.radar
          .filter(
            (r): r is { axis: string; value: number } =>
              !!r &&
              typeof r === 'object' &&
              typeof (r as { axis?: unknown }).axis === 'string' &&
              typeof (r as { value?: unknown }).value === 'number',
          )
          .map((r) => ({ axis: r.axis, value: clamp(r.value, 0, 100) }));
      }
      if (Array.isArray(parsed.topics)) {
        hints.topics = parsed.topics.filter((t): t is string => typeof t === 'string' && !!t);
      }
      return hints;
    } catch {
      this.apiCooldownUntil = Date.now() + API_COOLDOWN_MS;
      return tryLocalHints();
    }
  }

  // ── 画像聚合 ─────────────────────────────────────────────────────────────

  /**
   * 对方互动画像（仅私聊有意义，group 会话没有「对方」概念，UI 不提供入口）。
   * 本地统计为主、引擎提示增强；无引擎结果时全部走启发式（heuristic 标记）。
   */
  async getProfile(peerUid: string): Promise<IntentProfile> {
    const rows = await this.loadMessages('c2c', peerUid, PROFILE_WINDOW);
    const cache = this.cacheFor('c2c', peerUid);
    const byMsgId = new Map(cache.data.results.map((r) => [r.msgId, r]));

    let peerMsgs = 0;
    let selfMsgs = 0;
    let peerChars = 0;
    let emojiCount = 0;
    const peerTexts: string[] = [];
    const topicCounts = new Map<string, number>();
    const dayActivity = new Map<string, number>();
    const daySentiment = new Map<string, { sum: number; n: number }>();
    let analyzedPeer = 0;
    let sentimentWeighted = 0;
    let sentimentWeightSum = 0;
    let intensitySum = 0;
    const peerMsgLens: number[] = [];
    let initiatedByPeer = 0;
    let conversations = 0;
    let lastTime = 0;
    const GAP = 30 * 60; // 会话切分阈值，与 BuddyAnalytics 同量级

    for (const row of rows) {
      if (row.sendTime - lastTime > GAP) {
        conversations++;
        if (!row.mine) initiatedByPeer++;
      }
      lastTime = row.sendTime;

      const date = new Date(row.sendTime * 1000);
      const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      if (!row.mine) {
        dayActivity.set(dateKey, (dayActivity.get(dateKey) ?? 0) + 1);
        peerMsgs++;
        if (row.text) {
          peerTexts.push(row.text);
          peerChars += row.text.length;
          peerMsgLens.push(row.text.length);
          for (const word of segmentWords(row.text)) {
            topicCounts.set(word, (topicCounts.get(word) ?? 0) + 1);
          }
          for (const el of row.elementsRaw) {
            if (el.kind === 'face' || el.kind === 'mface') emojiCount++;
          }
        }
      } else {
        selfMsgs++;
      }
      const r = byMsgId.get(row.msgId);
      if (r && !r.mine) {
        analyzedPeer++;
        // 两周半衰期量级的时间衰减：老消息对「当前好感度」影响小。
        const w = Math.exp(-((Date.now() / 1000 - r.sendTime) / (14 * 86400)));
        sentimentWeighted += r.sentiment * w;
        sentimentWeightSum += w;
        intensitySum += r.intensity;
        const bucket = daySentiment.get(dateKey) ?? { sum: 0, n: 0 };
        bucket.sum += r.sentiment;
        bucket.n++;
        daySentiment.set(dateKey, bucket);
      }
    }

    // 回复延迟：对方接自己话的间隔（6h 内才算「在回话」）。
    const peerReplyLags: number[] = [];
    let prevSelfTime: number | null = null;
    for (const row of rows) {
      if (row.mine) {
        prevSelfTime = row.sendTime;
      } else if (prevSelfTime !== null && row.text) {
        const lag = row.sendTime - prevSelfTime;
        if (lag > 0 && lag < 6 * 3600) peerReplyLags.push(lag);
        prevSelfTime = null;
      }
    }

    // ---- 评分 -------------------------------------------------------------
    const sentimentAvg = sentimentWeightSum > 0 ? sentimentWeighted / sentimentWeightSum : 0;
    const avgIntensity = analyzedPeer > 0 ? intensitySum / analyzedPeer : 40;
    const avgLag =
      peerReplyLags.length > 0
        ? peerReplyLags.reduce((a, b) => a + b, 0) / peerReplyLags.length
        : 1800;
    // 30s → ~100 分，2h → ~0 分（对数刻度）。
    const lagScore = clamp(100 - (Math.log2(avgLag / 30 + 1) / Math.log2(7200 / 30)) * 100, 0, 100);
    const initiationScore =
      conversations > 0 ? clamp((initiatedByPeer / conversations) * 140, 0, 100) : 50;
    const densityScore = clamp((peerMsgs / Math.max(1, dayActivity.size)) * 12, 0, 100);
    const sentimentScore = clamp((sentimentAvg + 100) / 2, 0, 100);
    const affinity = clamp(
      Math.round(
        sentimentScore * 0.35 +
          lagScore * 0.2 +
          initiationScore * 0.2 +
          densityScore * 0.15 +
          Math.min(100, avgIntensity) * 0.1,
      ),
      0,
      100,
    );
    const tier =
      affinity >= 80 ? 4 : affinity >= 60 ? 3 : affinity >= 40 ? 2 : affinity >= 20 ? 1 : 0;

    // 走势：活跃日的当日情绪均分（7 成）+ 当日消息量（3 成）。
    const trend = [...daySentiment.entries()]
      .map(([date, b]) => ({
        date,
        score: clamp(
          Math.round(
            ((b.sum / b.n + 100) / 2) * 0.7 +
              Math.min(100, (dayActivity.get(date) ?? 0) * 10) * 0.3,
          ),
          0,
          100,
        ),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(-14);

    // 启发式 MBTI / 雷达（引擎提示可用时覆盖）。
    const avgLen = peerMsgLens.length > 0 ? peerChars / peerMsgLens.length : 0;
    const lenVar = peerMsgLens.length > 1 ? variance(peerMsgLens) : 0;
    const lagVar = peerReplyLags.length > 1 ? variance(peerReplyLags) : 0;
    const emojiRatio = peerMsgs > 0 ? emojiCount / peerMsgs : 0;
    const uniqueWords = topicCounts.size;
    const heuristicMbti: MbtiDim[] = [
      {
        key: 'EI',
        leftPct: clamp(
          Math.round(50 + (initiationScore - 50) * 0.4 + (emojiRatio - 0.15) * 80),
          0,
          100,
        ),
      },
      { key: 'SN', leftPct: clamp(Math.round(62 - Math.min(40, uniqueWords / 12)), 0, 100) },
      {
        key: 'TF',
        leftPct: clamp(Math.round(55 - (avgIntensity - 40) * 0.35 - emojiRatio * 60), 0, 100),
      },
      {
        key: 'JP',
        leftPct: clamp(
          Math.round(50 - normalizeVar(lagVar, avgLag) * 30 - normalizeVar(lenVar, avgLen) * 20),
          0,
          100,
        ),
      },
    ];
    const heuristicRadar: Array<{ axis: string; value: number }> = [
      { axis: RADAR_AXES[0] as string, value: Math.round(initiationScore) },
      { axis: RADAR_AXES[1] as string, value: Math.round(lagScore) },
      {
        axis: RADAR_AXES[2] as string,
        value: Math.round(clamp(avgIntensity * 0.7 + emojiRatio * 150, 0, 100)),
      },
      { axis: RADAR_AXES[3] as string, value: Math.round(clamp(uniqueWords * 2.2, 0, 100)) },
      { axis: RADAR_AXES[4] as string, value: Math.round(clamp(avgLen * 2.4, 0, 100)) },
    ];

    let mbtiDims = heuristicMbti;
    let radar = heuristicRadar;
    let engine: IntentProfile['engine'] = 'heuristic';
    let hintTopics: string[] | null = null;
    if (analyzedPeer >= 8) {
      const hints = await this.inferHints(peerTexts);
      if (hints) {
        engine = this.config.engine;
        if (hints.mbti && hints.mbti.length === 4) mbtiDims = hints.mbti;
        if (hints.radar && hints.radar.length >= 3) radar = mergeRadar(heuristicRadar, hints.radar);
        hintTopics = hints.topics ?? null;
      }
    }

    const topics = (
      hintTopics
        ? hintTopics.slice(0, 10).map((t) => ({ topic: t, count: topicCounts.get(t) ?? 0 }))
        : [...topicCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([topic, count]) => ({ topic, count }))
    ).filter((t) => t.count > 0 || hintTopics !== null);

    const letters = [...mbtiDims]
      .sort((a, b) => orderKey(a.key) - orderKey(b.key))
      .map((d) => (d.leftPct >= 50 ? d.key[0] : d.key[1]))
      .join('');

    return {
      affinity,
      tier,
      trend,
      mbti: { letters, dims: mbtiDims, heuristic: engine === 'heuristic' },
      radar,
      topics,
      sampled: peerMsgs + selfMsgs,
      analyzedSamples: analyzedPeer,
      engine,
      computedAt: Date.now(),
    };
  }

  // ── 回复建议（API 引擎优先 + 本地意图候选兜底）─────────────────────────────

  async getSuggestions(kind: IntentConversationKind, conv: string): Promise<ReplySuggestion[]> {
    if (!this.effectiveFor(kind, conv) || !this.config.suggestionsEnabled) return [];
    const revision = this.suggestionRevision;
    const contextMessages = this.config.suggestionContextMessages;
    const current = () => revision === this.suggestionRevision;
    const key = conversationKey(kind, conv);
    const rows = await this.loadMessages(kind, conv, contextMessages + 1);
    if (!current()) return [];
    if (rows.length === 0) return [];
    const last = rows[rows.length - 1] as SenseRow;
    if (last.mine) {
      this.suggestionCache.delete(key);
      return [];
    }
    const cachedHit = this.suggestionCache.get(key);
    if (
      cachedHit &&
      cachedHit.lastMsgId === last.msgId &&
      Date.now() - cachedHit.at < SUGGESTION_TTL_MS
    ) {
      return cachedHit.suggestions;
    }

    const fallbackLocal = (): ReplySuggestion[] => {
      if (!current()) return [];
      const cache = this.cacheFor(kind, conv);
      const analyzedLast = cache.data.results.find((r) => r.msgId === last.msgId);
      const context = extractContextBefore(rows, rows.length - 1, contextMessages);
      const suggestions = buildLocalSuggestions(last.text, analyzedLast, context, last.sendTime);
      this.suggestionCache.set(key, { lastMsgId: last.msgId, at: Date.now(), suggestions });
      return suggestions;
    };

    const stillLatestPeer = async (): Promise<boolean> => {
      if (!current()) return false;
      try {
        const latest = (await this.loadMessages(kind, conv, 1))[0];
        return current() && latest?.msgId === last.msgId && !latest.mine;
      } catch {
        return false;
      }
    };
    const fallbackAfterRequest = async () => ((await stillLatestPeer()) ? fallbackLocal() : []);

    if (this.config.engine === 'local') {
      return fallbackLocal();
    }

    const endpoint = this.endpoint();
    if (!endpoint || Date.now() < this.apiCooldownUntil) {
      return fallbackLocal();
    }
    const baseUrl = endpoint.baseUrl.replace(/\/+$/, '');

    const lines = rows.map((r) => `${r.mine ? '我' : '对方'}: ${r.text || '[媒体消息]'}`);
    const system =
      '根据聊天上下文，以「我」的口吻生成 3 条候选回复。要求：贴合语境、语气自然、' +
      '长度接近日常聊天（一般不超过 40 字）、三条风格要有差异（如 共情/幽默/简短）。' +
      '只输出 JSON：{"replies":[{"text":"...","tone":"共情"}]}，不要输出其它内容。';
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify({
          model: endpoint.model,
          temperature: 0.7,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: lines.join('\n') },
          ],
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (!current()) return [];
        this.apiCooldownUntil = Date.now() + API_COOLDOWN_MS;
        return fallbackAfterRequest();
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      };
      reportUsage(endpoint, body);
      if (!current()) return [];
      if (!(await stillLatestPeer())) return [];
      const parsed = extractJsonBlock(pickMessageText(body.choices?.[0]?.message)) as {
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
        .slice(0, 3);
      if (suggestions.length === 0) return fallbackLocal();
      this.suggestionCache.set(key, { lastMsgId: last.msgId, at: Date.now(), suggestions });
      return suggestions;
    } catch (error) {
      if (!current()) return [];
      this.apiCooldownUntil = Date.now() + API_COOLDOWN_MS;
      logger.debug('intent-sense suggestions failed', {
        event: 'intent-sense-suggestions-failed',
        ...logErrorContext(error),
      });
      return fallbackAfterRequest();
    }
  }

  // ── 消息读取（内部）─────────────────────────────────────────────────────

  /** 读最近 limit 条（或指定 msgId 集），返回时间升序、带分析文本与 mine 标记的行。 */
  private async loadMessages(
    kind: IntentConversationKind,
    conv: string,
    limit: number,
    onlyMsgIds?: string[],
  ): Promise<SenseRow[]> {
    const toRow = (m: C2cMsg | GroupMsg): SenseRow => {
      const mine =
        kind === 'c2c'
          ? (m as C2cMsg).senderUid !== conv // c2c：非对方即自己（buddy_analytics 同款判定）
          : String((m as GroupMsg).senderUin) === String(this.session.context.uin ?? '');
      return {
        msgId: m.msgId.toString(),
        mine,
        sendTime: Number(m.sendTime),
        text: elementsToSenseText(m.elements),
        elementsRaw: m.elements,
      };
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
      if (valid.length === 0) return [];
      const found =
        kind === 'c2c'
          ? await this.session.c2cMsgs.listByMsgIds(valid)
          : await this.session.groupMsgs.listByMsgIds(valid);
      return found.map(toRow);
    }
    if (kind === 'c2c') {
      const msgs = await this.session.c2cMsgs.listLatest(this.c2cPartition(conv), limit);
      return msgs.map(toRow).reverse(); // listLatest 新→旧，分析按时间升序
    }
    const msgs = await this.session.groupMsgs.listLatest(conv, limit);
    return msgs.map(toRow).reverse();
  }

  private c2cPartition(peerUid: string): C2cPartition {
    const sortNo = this.session.uidMap.sortNoByUid(peerUid);
    return sortNo !== undefined ? { sortNo } : { uid: peerUid };
  }

  private cacheFor(kind: IntentConversationKind, conv: string): JsonStore<CacheFile> {
    const key = conversationKey(kind, conv);
    const existing = this.analysisStores.get(key);
    if (existing) return existing;
    const store = new JsonStore<CacheFile>(
      `${this.storeDir}/analysis/${fileSafe(key)}.json`,
      () => ({
        version: CACHE_SCHEMA_VERSION,
        contextMessages: this.config.analysisContextMessages,
        results: [],
      }),
      { normalize: (raw) => normalizeCacheFile(raw, this.config.analysisContextMessages) },
    );
    this.analysisStores.set(key, store);
    return store;
  }

  /** 落缓存 + 裁剪到上限（按 sendTime 丢最旧）+ 落盘。 */
  private storeResults(
    kind: IntentConversationKind,
    conv: string,
    results: IntentSenseResult[],
  ): void {
    const store = this.cacheFor(kind, conv);
    const merged = new Map(store.data.results.map((r) => [r.msgId, r]));
    for (const r of results) merged.set(r.msgId, r);
    let all = [...merged.values()];
    if (all.length > CACHE_MAX_ENTRIES) {
      all = [...all].sort((a, b) => a.sendTime - b.sendTime).slice(all.length - CACHE_MAX_ENTRIES);
    }
    store.data = {
      version: CACHE_SCHEMA_VERSION,
      contextMessages: this.config.analysisContextMessages,
      results: all,
    };
    store.save();
  }
}

/** 内部读取行（loadMessages 的产物）。 */
interface SenseRow {
  msgId: string;
  mine: boolean;
  sendTime: number;
  text: string;
  elementsRaw: Element[];
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function variance(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
}

/** 变异系数 0..1（离散程度归一，供 J/P 的「节奏稳定性」打分）。 */
function normalizeVar(vari: number, mean: number): number {
  if (mean <= 0) return 0.5;
  return clamp(Math.sqrt(vari) / mean / 2, 0, 1);
}

function orderKey(key: MbtiDim['key']): number {
  return ['EI', 'SN', 'TF', 'JP'].indexOf(key);
}

/** 引擎雷达值与启发式雷达值折中（引擎 0.65 / 启发式 0.35，缺轴补启发式）。 */
function mergeRadar(
  heuristic: Array<{ axis: string; value: number }>,
  hints: Array<{ axis: string; value: number }>,
): Array<{ axis: string; value: number }> {
  const byAxis = new Map(hints.map((r) => [r.axis, r.value]));
  return heuristic.map((h) => {
    const v = byAxis.get(h.axis);
    return v === undefined ? h : { axis: h.axis, value: Math.round(h.value * 0.35 + v * 0.65) };
  });
}

/**
 * 基于最新对方消息的意图与情绪（本地模型分析结果或语料库预分析）生成 3 条差异化回复候选。
 * 供本地引擎模式或 API 故障熔断时作为即时回复建议。
 */
function buildLocalSuggestions(
  text: string,
  analyzed: IntentSenseResult | undefined,
  context: IntentContextTurn[],
  sendTime: number,
): ReplySuggestion[] {
  const prag = analyzePragmatics(text, context, sendTime);
  const intent: IntentKind =
    analyzed?.intent ??
    prag.override?.intent ??
    (/[？?]|吗$|呢$|怎么|为什么|为啥|多少|哪/.test(text) ? 'question' : 'chat');
  const emotion: EmotionKind = analyzed?.emotion ?? prag.override?.emotion ?? 'neutral';

  switch (intent) {
    case 'question':
      return [
        { text: '稍等我确认一下跟你说~', tone: '稳妥' },
        { text: '这个我还真知道，展开跟你讲讲', tone: '热心' },
        { text: '哈哈怎么突然问起这个？', tone: '反问' },
      ];
    case 'request':
      return [
        { text: '没问题，包在我身上！', tone: '爽快' },
        { text: '好嘞，我这就去弄，弄好叫你', tone: '靠谱' },
        { text: '手头稍微有点事，晚几分钟帮你看可以吗？', tone: '委婉' },
      ];
    case 'plan':
      return [
        { text: '包的！直接冲，几点集合？', tone: '积极' },
        { text: '可以呀，算我一个~', tone: '随和' },
        { text: '我先看下时间安排，待会给你准信', tone: '稳妥' },
      ];
    case 'greeting':
      return [
        { text: '在的在的，刚忙完~', tone: '热情' },
        { text: '哈哈早呀，今天心情不错嘛', tone: '轻松' },
        { text: '咋啦，有什么好玩的事？', tone: '好奇' },
      ];
    case 'praise':
    case 'flattery':
      return [
        { text: '哈哈低调低调，还得靠大家捧场~', tone: '谦虚' },
        { text: '被你夸得我都要飘了哈哈哈', tone: '幽默' },
        { text: '还得是你懂行！下次带你一起整', tone: '互动' },
      ];
    case 'boast':
      return [
        { text: '卧槽太强了吧！给大佬跪了', tone: '捧场' },
        { text: '羡慕哭了，分我一点欧气！', tone: '玩梗' },
        { text: '牛哇，这波必须请客庆祝一下', tone: '调侃' },
      ];
    case 'vent':
      if (emotion === 'aggrieved' || emotion === 'sadness') {
        return [
          { text: '抱抱你，别太往心里去，真的辛苦了', tone: '安慰' },
          { text: '这也太欺负人了吧，换我也得气死！', tone: '共情' },
          { text: '不气不气，待会吃点好的转换下心情', tone: '暖心' },
        ];
      }
      if (emotion === 'fatigue') {
        return [
          { text: '辛苦啦！赶紧歇一歇回回血', tone: '关心' },
          { text: '打工人太难了，今晚必须早点睡', tone: '共情' },
          { text: '走，搞杯奶茶续命！', tone: '轻松' },
        ];
      }
      return [
        { text: '懂你，这事换谁遇到都得血压飙升', tone: '共情' },
        { text: '太离谱了吧，后来怎么解决的？', tone: '追问' },
        { text: '摸摸头，消消气，别拿别人的错误惩罚自己', tone: '安慰' },
      ];
    case 'joke':
    case 'banter':
      return [
        { text: '哈哈哈哈笑死我了，你真是个人才', tone: '接梗' },
        { text: '你小子夺笋啊，等着瞧！', tone: '互怼' },
        { text: '蚌埠住了，今天功德又被你笑没了', tone: '玩梗' },
      ];
    case 'gossip':
      return [
        { text: '搬好小板凳了，快展开讲讲！', tone: '吃瓜' },
        { text: '尊嘟假嘟？还有这种操作？', tone: '好奇' },
        { text: '这瓜保熟吗哈哈，细说后续', tone: '调侃' },
      ];
    case 'coquetry':
      return [
        { text: '好啦好啦，都依你行了吧~', tone: '宠溺' },
        { text: '摸摸头，拿你没办法，走起！', tone: '温柔' },
        { text: '哈哈少来这套，说吧想要啥？', tone: '打趣' },
      ];
    case 'perfunctory':
      return [
        { text: '哈哈看破不说破，先不打扰你忙啦', tone: '体贴' },
        { text: '好家伙，这敷衍得也太明显了吧😂', tone: '调侃' },
        { text: '行嘞，有空再聊~', tone: '简短' },
      ];
    case 'share':
    case 'info':
      return [
        { text: '收到！太及时了，多谢分享~', tone: '感谢' },
        { text: '哇看着很不错诶，回头我也试试', tone: '感兴趣' },
        { text: '了解，我记一下！', tone: '简短' },
      ];
    default:
      return [
        { text: '哈哈确实，我也这么觉得', tone: '赞同' },
        { text: '展开说说？后来呢', tone: '好奇' },
        { text: '好的呀，没问题~', tone: '简短' },
      ];
  }
}

/**
 * AgentRuntime —— 克隆体「运行时对话引擎」（纯，不依赖 Electron / NTQQ / tRPC）。
 *
 * 从 service 层 AgentLabService 下沉而来：桌面端与导出的独立 bot **共用同一套引擎**。
 * 只做「给定 persona + 历史 + 输入 → 产出有序标记文本（含语音合成 / 记忆 / 反思）」，
 * 一切外部资源（LLM 端点、TTS、各类持久化 store、自身身份 id）都靠依赖注入（Port 接口）传入。
 *
 * 边界：**运行时**逻辑在这里；**蒸馏期**（拉 QQ 语料 / 转录 / 表情下载 / 建 persona）仍留在
 * service 层，因为那些绑死 AccountSession / 媒体管线。群聊多克隆体连锁编排暂留 service（M3 再议），
 * 但它复用本类的 generatePersonaTurns / synthesizeVoice。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPersonaChat, embedTexts } from './http';
import { scoreReplyGate, willingLevelBias } from './reply_gate';
import { describeRelationTone } from './relation';
import { distillMemories, reflectConversation, scoreInteractionSentiment } from './extract';
import type { AgentLabStore } from './store';
import type {
  AgentLabPersona,
  AgentLabStoredPair,
  AgentLabChatTurn,
  AgentLabModelRef,
  AgentLabEndpoint,
  AgentLabMemoryItem,
  AgentLabPersonaNotes,
  AgentLabRelationStore,
} from './types';

// ── 依赖注入 Port 接口 ─────────────────────────────────────────────────────
// 现有 service store（MemoryStore/NotesStore/ConversationStore/TokenUsageStore）与 TtsService
// 通过 TS 结构类型天然满足这些接口；bot 侧可提供自己的实现（JSON 落盘 / 其它后端）。

/** LLM 端点解析：把 persona 里的 { providerId, model } 引用解析成可直接 fetch 的 endpoint。 */
export type EndpointResolver = (ref: AgentLabModelRef) => AgentLabEndpoint;

/** token 记账落点（TokenUsageStore 满足）。 */
export interface UsageSink {
  record(entry: {
    ts: number;
    model: string;
    kind: 'chat' | 'embedding' | 'vision';
    personaId?: string;
    scope: 'build' | 'chat' | 'assistant';
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }): void;
}

/** 对话历史落点（ConversationStore 满足；只用 role/text/ts 三字段）。 */
export interface ConversationTurnLike {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}
export interface ConversationSink {
  get(agentId: string): ConversationTurnLike[];
  append(agentId: string, turns: ConversationTurnLike[]): void;
}

/** 记忆库落点（MemoryStore 满足）。 */
export interface MemorySink {
  get(personaId: string): AgentLabMemoryItem[];
  /** 只取「关于指定成员」的记忆（群聊防串人）；includeUntagged=true 把无 aboutId 的旧记忆也算上。 */
  getAbout(personaId: string, aboutIds: string[], includeUntagged?: boolean): AgentLabMemoryItem[];
  touch(personaId: string, ids: string[], now: number): void;
  add(
    personaId: string,
    texts: string[],
    now: number,
    about?: { aboutId: string; aboutKind: 'user' | 'persona' },
    embeddings?: Array<number[] | undefined>,
  ): void;
}

/** 反思笔记落点（NotesStore 满足）。 */
export interface NotesSink {
  get(personaId: string): AgentLabPersonaNotes;
  getReflectedCount(personaId: string): number;
  setReflectedCount(personaId: string, count: number): void;
  add(personaId: string, corrections: string[], episode: string): void;
}

/** TTS 合成端口（把 service 的 { service, getProvider } 抽象成 providerId 维度，解耦厂商类型）。 */
export interface TtsSynthesisOptions {
  refClip?: { path: string; text: string };
  auxRefClips?: Array<{ path: string; text: string }>;
  voice?: string;
}
export interface TtsPort {
  /** 该 provider 的能力；null = 找不到 provider（视为不可用）。 */
  getCapabilities(providerId: string): { clone: boolean; fixedVoice: boolean } | null;
  synthesize(
    providerId: string,
    text: string,
    opts: TtsSynthesisOptions,
  ): Promise<{ audio: Uint8Array; format: string }>;
}

/** 可选日志端口（service 的 getLogger().child(...) 满足；缺省则静默）。 */
export interface RuntimeLogger {
  child(ctx: Record<string, unknown>): RuntimeLogger;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export interface AgentRuntimeDeps {
  /** agentlab 根目录（合成语音落 <rootDir>/agentvoice/）。 */
  rootDir: string;
  store: AgentLabStore;
  endpoints: EndpointResolver;
  usage: UsageSink;
  conversations: ConversationSink;
  memories: MemorySink;
  notes: NotesSink;
  relations: AgentLabRelationStore;
  /** 自身身份 id（桌面 = 登录账号 uin；bot = bot QQ 号）。用于私聊意愿闸取「对我」的关系。 */
  selfId: string;
  /** 语音合成（缺省则克隆体不发语音，降级纯文字）。 */
  tts?: TtsPort;
  logger?: RuntimeLogger;
}

const MEMORY_DISTILL_EVERY = 6;
const REFLECT_EVERY = 8;
const MIN_UNREFLECTED = 4;

export class AgentRuntime {
  private readonly rootDir: string;
  private readonly store: AgentLabStore;
  private readonly endpoints: EndpointResolver;
  private readonly usage: UsageSink;
  private readonly conversations: ConversationSink;
  private readonly memories: MemorySink;
  private readonly notes: NotesSink;
  private readonly relations: AgentLabRelationStore;
  private readonly selfId: string;
  private readonly tts?: TtsPort;
  private readonly logger?: RuntimeLogger;

  constructor(deps: AgentRuntimeDeps) {
    this.rootDir = deps.rootDir;
    this.store = deps.store;
    this.endpoints = deps.endpoints;
    this.usage = deps.usage;
    this.conversations = deps.conversations;
    this.memories = deps.memories;
    this.notes = deps.notes;
    this.relations = deps.relations;
    this.selfId = deps.selfId;
    this.tts = deps.tts;
    this.logger = deps.logger;
  }

  private selfMemberId(): string {
    return this.selfId;
  }

  /** 解析 endpoint 并挂上 token 记账回调。 */
  private resolveWithUsage(
    ref: AgentLabModelRef,
    kind: 'chat' | 'embedding' | 'vision',
    ctx: { personaId?: string; scope: 'build' | 'chat' | 'assistant' },
  ): AgentLabEndpoint {
    const ep = this.endpoints(ref);
    return {
      ...ep,
      kind,
      onUsage: (u) =>
        this.usage.record({
          ts: Date.now(),
          model: u.model,
          kind: u.kind,
          personaId: ctx.personaId,
          scope: ctx.scope,
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          totalTokens: u.totalTokens,
        }),
    };
  }

  /** 克隆体的兴趣关键词（话题 + 口头禅 + 高频词），供意愿闸判断「聊到感兴趣的」。 */
  private personaInterestTerms(persona: AgentLabPersona): string[] {
    const card = persona.profile?.card;
    const terms = [
      ...(card?.topics ?? []),
      ...(card?.catchphrases ?? []),
      ...(persona.profile?.topTerms ?? []),
    ];
    return Array.from(new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2)));
  }

  /** 合成语音的落盘目录（<rootDir>/agentvoice/，懒建）。 */
  private agentVoiceDir(): string {
    const dir = join(this.rootDir, 'agentvoice');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 按 id 解析某条合成语音的本地路径。id 必须是安全 basename（仅 hex + .mp3/.wav），防目录逃逸。 */
  getAgentVoicePath(id: string): string | null {
    if (!/^[0-9a-f]+\.(mp3|wav)$/i.test(id)) return null;
    const path = join(this.agentVoiceDir(), id);
    return existsSync(path) ? path : null;
  }

  /**
   * 这个克隆体当前能不能发语音：开了语音克隆 + 绑了 provider + 该 provider 能力匹配。
   * clone 模式还要求 provider 支持复刻且有参考音频；preset 模式要求 provider 支持固定音色。
   */
  isVoiceReady(persona: AgentLabPersona): boolean {
    if (!persona.voiceCloneEnabled || !persona.voice || !this.tts) return false;
    const caps = this.tts.getCapabilities(persona.voice.providerId);
    if (!caps) return false;
    if (persona.voice.mode === 'clone') {
      return caps.clone && (persona.voiceProfile?.refClips?.length ?? 0) > 0;
    }
    return caps.fixedVoice;
  }

  /**
   * 合成一条语音，写到 agentvoice/<hash>.<ext>，返回文件名（id）。失败返回 null（调用方降级文字）。
   * clone 模式用 TA 的参考音频复刻；preset 模式用预置音色（provider 默认音色由 TtsPort 实现兜底）。
   */
  async synthesizeVoice(persona: AgentLabPersona, text: string): Promise<string | null> {
    const voice = persona.voice;
    const log = this.logger?.child({ personaId: persona.id, textLen: text.length });
    if (!this.tts || !voice) {
      log?.warn('语音合成跳过：未接入 TTS 或克隆体没绑定语音', { hasTts: !!this.tts, hasVoiceBinding: !!voice });
      return null;
    }
    const caps = this.tts.getCapabilities(voice.providerId);
    if (!caps) {
      log?.warn('语音合成失败：找不到 TTS provider（可能已被删除或未配置）', { providerId: voice.providerId });
      return null;
    }
    try {
      const opts: TtsSynthesisOptions = {};
      if (voice.mode === 'clone') {
        const refClips = persona.voiceProfile?.refClips ?? [];
        const clips = refClips.filter((c) => existsSync(c.path));
        if (clips.length === 0) {
          log?.warn('语音合成失败：clone 模式但没有可用的参考音频（refClips 为空或 wav 文件已丢失）', {
            refClipCount: refClips.length,
          });
          return null;
        }
        opts.refClip = { path: clips[0]!.path, text: clips[0]!.text };
        opts.auxRefClips = clips.slice(1, 3).map((c) => ({ path: c.path, text: c.text }));
      } else {
        opts.voice = voice.voice;
      }
      const { audio, format } = await this.tts.synthesize(voice.providerId, text, opts);
      const ext = format === 'wav' ? 'wav' : 'mp3';
      const hash = createHash('sha1')
        .update(`${persona.id}|${voice.providerId}|${voice.mode}|${voice.voice ?? ''}|${text}`)
        .digest('hex')
        .slice(0, 16);
      const id = `${hash}.${ext}`;
      const dest = join(this.agentVoiceDir(), id);
      if (!existsSync(dest)) writeFileSync(dest, audio);
      log?.info('语音合成成功', { id, mode: voice.mode, bytes: audio.length });
      return id;
    } catch (error) {
      log?.error('语音合成异常，降级为文字', {
        providerId: voice.providerId,
        mode: voice.mode,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 单个克隆体「给定历史 + 当前输入 → 产出有序标记文本」的共享生成逻辑（私聊 chat 与群聊复用）。
   * 只做生成 + 记忆命中记账 + action→标记文本（含语音合成），不碰任何对话落库——落哪由调用方决定。
   */
  async generatePersonaTurns(
    persona: AgentLabPersona,
    pairs: AgentLabStoredPair[],
    opts: {
      chatEndpoint: AgentLabEndpoint;
      embeddingEndpoint: AgentLabEndpoint | null;
      history: AgentLabChatTurn[];
      input: string;
      now: number;
      relationNote?: string;
      memories?: AgentLabMemoryItem[];
    },
  ): Promise<{ result: Awaited<ReturnType<typeof runPersonaChat>>; renderedTurns: string[] }> {
    const voiceEnabled = this.isVoiceReady(persona);
    const result = await runPersonaChat(opts.chatEndpoint, opts.embeddingEndpoint, {
      persona,
      pairs,
      history: opts.history,
      input: opts.input,
      memories: opts.memories ?? this.memories.get(persona.id),
      notes: this.notes.get(persona.id),
      voiceEnabled,
      relationNote: opts.relationNote,
    });
    // 命中的记忆 +access（越常被想起越不易遗忘）。
    this.memories.touch(persona.id, result.usedMemoryIds, opts.now);

    // 按 actions 顺序转成标记文本（text / 表情 [[sticker:md5]] / 语音 [[voice:id]]）。
    // 语音合成失败则降级为文字，不丢内容。
    const renderedTurns: string[] = [];
    for (const action of result.actions) {
      if (action.kind === 'text') {
        renderedTurns.push(action.text);
      } else if (action.kind === 'sticker') {
        renderedTurns.push(`[[sticker:${action.sticker.md5}]]`);
      } else {
        const voiceId = await this.synthesizeVoice(persona, action.text);
        renderedTurns.push(voiceId ? `[[voice:${voiceId}]]` : action.text);
      }
    }
    if (renderedTurns.length === 0) renderedTurns.push(result.text);
    return { result, renderedTurns };
  }

  /**
   * 私聊入口：给定 personaId + 历史 + 用户输入 → 生成回复（有序标记文本）并落对话库。
   * 意愿闸（可选，persona.willing.gatePrivate）没过则保持沉默、只记用户这条。
   */
  async chat(input: { personaId: string; history: AgentLabChatTurn[]; text: string }) {
    const record = this.store.getPersona(input.personaId);
    if (!record) throw new Error('找不到 persona');
    if (!record.persona.models?.chat) throw new Error('这是旧版克隆体，模型结构已更新，请删除后重建');
    const ctx = { personaId: input.personaId, scope: 'chat' as const };
    const chatEndpoint = this.resolveWithUsage(record.persona.models.chat, 'chat', ctx);
    const embeddingEndpoint = record.persona.models.embedding
      ? this.resolveWithUsage(record.persona.models.embedding, 'embedding', ctx)
      : null;

    // 发言意愿对私聊生效（可选）：意愿闸没过就保持沉默，只记下用户这条，不回。
    const willing = record.persona.willing;
    if (willing?.gatePrivate) {
      const decision = scoreReplyGate({
        text: input.text,
        personaName: record.persona.name,
        fromOwner: true,
        interestTerms: this.personaInterestTerms(record.persona),
        relation: this.relations.get(input.personaId, this.selfMemberId()),
        levelBias: willingLevelBias(willing.level),
        mustReplyOnMention: willing.mustReplyOnMention !== false,
      });
      if (!decision.shouldReply) {
        const ts = Date.now();
        this.conversations.append(input.personaId, [{ role: 'user', text: input.text, ts }]);
        return {
          text: '',
          segments: [],
          actions: [],
          promptPreview: '',
          matches: [],
          usedMemoryIds: [],
          willingness: decision.score,
          replyDelayMs: 0,
          sticker: null,
          renderedTurns: [] as string[],
          silent: true,
        };
      }
    }

    const now = Date.now();
    const { result, renderedTurns } = await this.generatePersonaTurns(record.persona, record.pairs, {
      chatEndpoint,
      embeddingEndpoint,
      history: input.history,
      input: input.text,
      now,
    });

    const assistantTurns: ConversationTurnLike[] = renderedTurns.map((text) => ({
      role: 'assistant',
      text,
      ts: now,
    }));
    this.conversations.append(input.personaId, [
      { role: 'user', text: input.text, ts: now },
      ...assistantTurns,
    ]);

    // 每隔若干轮，从最近对话蒸馏记忆 + 反思扮演效果（都不阻塞本次回复）。
    void this.maybeDistillMemories(input.personaId, record.persona.name, chatEndpoint);
    void this.maybeReflect(input.personaId, record.persona.name, chatEndpoint);

    return { ...result, renderedTurns, silent: false };
  }

  /** 每 MEMORY_DISTILL_EVERY 个用户回合蒸馏一次记忆；fire-and-forget，失败静默。 */
  private async maybeDistillMemories(
    personaId: string,
    peerName: string,
    chatEndpoint: AgentLabEndpoint,
  ): Promise<void> {
    try {
      const conv = this.conversations.get(personaId);
      const userTurns = conv.filter((t) => t.role === 'user').length;
      if (userTurns === 0 || userTurns % MEMORY_DISTILL_EVERY !== 0) return;
      const known = this.memories
        .get(personaId)
        .map((m) => m.text)
        .slice(-40);
      const fresh = await distillMemories(
        chatEndpoint,
        peerName,
        conv.map((t) => ({ role: t.role, text: t.text })),
        known,
      );
      if (fresh.length === 0) return;
      // 私聊记忆标记 aboutId=被克隆好友本人（对方），配了向量模型时嵌入以便语义召回。
      const persona = this.store.getPersona(personaId)?.persona;
      const aboutId = persona?.sourceId;
      let embeddings: Array<number[] | undefined> | undefined;
      if (persona?.models.embedding) {
        try {
          const embEndpoint = this.resolveWithUsage(persona.models.embedding, 'embedding', {
            personaId,
            scope: 'chat',
          });
          embeddings = await embedTexts(embEndpoint, fresh);
        } catch {
          /* 嵌入失败就退化成关键词召回 */
        }
      }
      this.memories.add(
        personaId,
        fresh,
        Date.now(),
        aboutId ? { aboutId, aboutKind: 'user' } : undefined,
        embeddings,
      );
    } catch {
      /* 记忆蒸馏失败不影响聊天 */
    }
  }

  /**
   * 每 REFLECT_EVERY 个用户回合反思一次扮演效果；用 reflectedCount 水位只反思新增片段，
   * 提炼出的 corrections（必须遵守）/ summary（episode）写入 NotesSink。fire-and-forget，失败静默。
   */
  private async maybeReflect(
    personaId: string,
    peerName: string,
    chatEndpoint: AgentLabEndpoint,
  ): Promise<void> {
    try {
      const conv = this.conversations.get(personaId);
      const userTurns = conv.filter((t) => t.role === 'user').length;
      if (userTurns === 0 || userTurns % REFLECT_EVERY !== 0) return;
      const reflected = this.notes.getReflectedCount(personaId);
      const unreflected = conv.slice(reflected);
      if (unreflected.length < MIN_UNREFLECTED) return;
      const result = await reflectConversation(
        chatEndpoint,
        peerName,
        unreflected.map((t) => ({ role: t.role, text: t.text })),
      );
      if (result.corrections.length > 0 || result.summary) {
        this.notes.add(personaId, result.corrections, result.summary);
      }
      // 无论是否提炼出内容都推进水位，避免下次重复反思同一段。
      this.notes.setReflectedCount(personaId, conv.length);
    } catch {
      /* 对话反思失败不影响聊天 */
    }
  }

  /**
   * 群聊入口（单 persona 在真实群）：先过意愿闸决定要不要回，回则用群历史 + 对该群友的关系态生成回复，
   * 并异步更新对该群友的关系。不做多克隆连锁（那是桌面内玩法）。
   */
  async handleGroupMessage(input: {
    personaId: string;
    senderId: string;
    senderName: string;
    text: string;
    mentionsSelf: boolean;
    history: AgentLabChatTurn[];
    /** 最近若干条里自己的占比（存在感惩罚，0~1）。 */
    selfShareRecent?: number;
    /** 距自己上次发言的毫秒数（冷却）。 */
    msSinceOwnLastReply?: number;
  }): Promise<{ renderedTurns: string[]; replyDelayMs: number; silent: boolean; reason: string; score: number }> {
    const record = this.store.getPersona(input.personaId);
    if (!record?.persona.models?.chat) return { renderedTurns: [], replyDelayMs: 0, silent: true, reason: 'no-chat-model', score: 0 };
    const persona = record.persona;
    const willing = persona.willing;
    const relation = this.relations.get(input.personaId, input.senderId);

    const decision = scoreReplyGate({
      text: input.text,
      personaName: persona.name,
      mentioned: input.mentionsSelf,
      fromOwner: false,
      interestTerms: this.personaInterestTerms(persona),
      relation,
      selfShareRecent: input.selfShareRecent,
      msSinceOwnLastReply: input.msSinceOwnLastReply,
      levelBias: willingLevelBias(willing?.level),
      mustReplyOnMention: willing?.mustReplyOnMention !== false,
    });
    if (!decision.shouldReply) {
      return { renderedTurns: [], replyDelayMs: decision.replyDelayMs, silent: true, reason: decision.reason, score: decision.score };
    }

    const ctx = { personaId: input.personaId, scope: 'chat' as const };
    const chatEndpoint = this.resolveWithUsage(persona.models.chat, 'chat', ctx);
    const embeddingEndpoint = persona.models.embedding
      ? this.resolveWithUsage(persona.models.embedding, 'embedding', ctx)
      : null;
    const relationNote = relation ? describeRelationTone(relation) : undefined;
    // 只召回「关于这个群友」的记忆，防串人（includeUntagged=true 把旧的无标记记忆也算上）。
    const memories = this.memories.getAbout(input.personaId, [input.senderId], true);
    const now = Date.now();
    const { renderedTurns } = await this.generatePersonaTurns(persona, record.pairs, {
      chatEndpoint,
      embeddingEndpoint,
      history: input.history,
      input: `「${input.senderName}」：${input.text}`,
      now,
      relationNote,
      memories,
    });

    // 异步更新对该群友的关系（不阻塞回复）。
    this.updateGroupRelation(
      input.personaId,
      persona.name,
      input.senderId,
      `对方(${input.senderName})：${input.text}\n你：${renderedTurns.join(' ')}`,
      chatEndpoint,
    );
    return { renderedTurns, replyDelayMs: decision.replyDelayMs, silent: false, reason: decision.reason, score: decision.score };
  }

  /**
   * 一段群聊互动后更新「克隆体 → 群友」的关系态。fire-and-forget：
   * 每次互动熟悉度 +2；每 5 次互动做一次 LLM 情感打分调 affinity/mood。
   */
  private updateGroupRelation(
    personaId: string,
    personaName: string,
    objectId: string,
    exchange: string,
    endpoint: AgentLabEndpoint,
  ): void {
    void (async () => {
      try {
        const prev = this.relations.get(personaId, objectId);
        const nextCount = (prev?.interactionCount ?? 0) + 1;
        const delta: { familiarity: number; affinity?: number; mood?: number } = { familiarity: 2 };
        if (nextCount % 5 === 0) {
          const s = await scoreInteractionSentiment(endpoint, personaName, exchange);
          delta.affinity = s.affinityDelta;
          delta.mood = s.moodDelta;
        }
        this.relations.applyDelta(personaId, objectId, 'user', delta, Date.now());
      } catch {
        /* 关系更新失败不影响聊天 */
      }
    })();
  }
}

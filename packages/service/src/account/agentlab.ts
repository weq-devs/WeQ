import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import {
  AgentLabStore,
  AgentRuntime,
  buildPersonaArtifacts,
  describeSticker,
  distillMemories,
  embedTexts,
  extractExpressions,
  extractFewShots,
  extractPersonaCard,
  extractProfileChunk,
  mergeProfileParts,
  renderProfileChunks,
  scoreInteractionSentiment,
  decideGroupReply,
  describeRelationTone,
  makeBaseRelation,
  summarizeVoiceScenario,
  C2C_SAFETY_CAP,
  C2C_CORPUS_CAP,
  FACE_WHITELIST_CAP,
  GROUP_MAX,
  GROUP_SUPPLEMENT_THRESHOLD,
  GROUP_TOTAL_CAP,
  PER_GROUP_MSG_CAP,
  PER_GROUP_SCAN_CAP,
  STICKER_CAP,
  VOICE_TRANSCRIBE_CAP,
  type AgentLabChatTurn,
  type AgentLabConversationSample,
  type AgentLabEndpoint,
  type AgentLabExpression,
  type AgentLabMessage,
  type AgentLabModelRef,
  type AgentLabModels,
  type AgentLabPersona,
  type AgentLabPersonaDeepProfile,
  type AgentLabPersonaNotes,
  type AgentLabPersonaProfile,
  type AgentLabStickerRef,
  type AgentLabStoredPair,
  type AgentLabTurn,
  type AgentLabUsage,
  type AgentLabVoiceProfile,
  type AgentLabVoiceRefClip,
  type AgentLabVoiceBinding,
  type AgentLabGroupStore,
  type AgentLabRelationStore,
  type AgentLabGroup,
  type AgentLabGroupMember,
  type AgentLabGroupMessage,
  type AgentLabRelation,
  type AgentLabWillingConfig,
  type TtsPort,
  type TtsProviderConfig,
  type TtsService,
} from '@weq/agentlab';
import type { UserProfile } from '@weq/db';
import type { Element } from '@weq/codec';
import type { C2cMsg, GroupMsg, C2cPartition } from '@weq/db';
import type { FileSearchService } from './file_search';
import {
  MediaDownloadService,
  PRIVATE_IMAGE_RKEY_TYPE,
  GROUP_IMAGE_RKEY_TYPE,
  PRIVATE_PTT_RKEY_TYPE,
  GROUP_PTT_RKEY_TYPE,
} from './media_download';
import { TokenUsageStore, type TokenStats } from './agentlab_usage';
import { ConversationStore, type ConversationTurn } from './agentlab_conversation';
import { MemoryStore } from './agentlab_memory';
import { NotesStore } from './agentlab_notes';
import { JsonGroupStore } from './agentlab_group_store';
import { JsonRelationStore } from './agentlab_relation_store';
import { getLogger } from '../common/logger';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 把 (providerId, model) 解析成可调用端点；由 bootstrap 的 AgentLabConfigService 提供。 */
export type EndpointResolver = (ref: AgentLabModelRef) => AgentLabEndpoint;

/**
 * 蒸馏期需要的「媒体 / 语音」能力（来自应用层）。全部可选——缺失即降级：
 * 没有 media 就不补全表情/语音，没有 transcribe/voiceReady 就不转录语音。
 * 镜像 ExportTaskManager 的注入方式（silk 解码 / sherpa 转录是 app 侧 native）。
 */
export interface AgentLabMediaDeps {
  fileSearch: FileSearchService;
  mediaDownload: MediaDownloadService;
  /** silk → 文本（内部自己解码成 16k wav 再跑识别）。 */
  transcribe?: (silkPath: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  /** silk → wav 文件（留一份给将来的语音克隆用）。 */
  decodeSilkToWavFile?: (silkPath: string, destPath: string) => Promise<boolean>;
  /** 当前是否配了可用的转录模型（已选且已下载）。 */
  voiceReady?: () => boolean;
}

/**
 * 语音合成能力（来自应用层 / bootstrap）。可选——缺失则克隆体不发语音。
 * getProvider 按 persona.voice.providerId 从全局 AppSettings 取 TTS 服务商配置。
 */
export interface AgentLabTtsDeps {
  service: TtsService;
  getProvider: (providerId: string) => TtsProviderConfig | null;
}

/** 蒸馏期收集的语音克隆参考候选（之后按质量打分挑 Top-K）。 */
interface VoiceClipCandidate {
  path: string;
  text: string;
  durationMs: number;
  score: number;
}

/** 语音克隆参考音频的目标条数（与 selectRefClips 的 Top-K 对齐）：攒够就停止打捞。 */
const VOICE_REF_NEED = 5;

/** 克隆构建进度事件（前端进度条用；一次构建一串事件，done/error 收尾）。 */
export interface AgentLabBuildProgress {
  personaId: string;
  /** 当前阶段中文标签，如「拉取聊天记录」「转录语音」。 */
  phase: string;
  /** 0–100。 */
  percent: number;
  /** 成功收尾。 */
  done?: boolean;
  /** 失败收尾（携带错误信息）。 */
  error?: string;
}

/** buildFromC2c 入参。 */
export interface BuildFromC2cInput {
  personaId: string;
  name?: string;
  models: AgentLabModels;
  customPrompt?: string;
  targetUid: string;
  title?: string;
  limit?: number;
  /**
   * 语料模式（替代旧的克隆程度 high/low）：
   *   - 'private'：纯私聊取语料，语料不足也不回退群聊（快、纯净）。
   *   - 'group'：私聊为主，私聊有效语料不足时去群里补采风格（只学语气、不构成问答对）。
   * 默认 'group'。
   */
  mode?: 'private' | 'group';
}

/** 高频表情包累计：扫描期收集，之后再下载 + vision 解读。 */
interface StickerAccum {
  md5: string;
  fileName: string;
  fileToken: string;
  originalUrl: string;
  ts: number;
  count: number;
  /** TA 发这张前最近的真实对话短句（≤3 条，去重）：喂 vision 判断场景 + 存进 ref。 */
  contexts: string[];
}

/** 每张表情保留的使用情境条数 / 单条字符上限（借鉴 CipherTalk personaStickers）。 */
const STICKER_CONTEXT_MAX = 3;
const STICKER_CONTEXT_CHAR_CAP = 30;

/** 纯占位符（无真实文本）——群补采计数时不算有效语料。 */
const PLACEHOLDER_ONLY = /^(\s*(\[图片\]|\[视频\]|\[语音\]|\[回复\]|\[文件\]|\[动画表情\]))+\s*$/;

function isMeaningful(text: string): boolean {
  const t = text.trim();
  return !!t && !PLACEHOLDER_ONLY.test(t);
}

function textFromElements(elements: Element[]): string {
  return elements
    .map((el) => {
      if (el.kind === 'text' || el.kind === 'at') return String(el.textContent ?? '').trim();
      if (el.kind === 'face') return String(el.faceText ?? '').trim();
      if (el.kind === 'pic') return '[图片]';
      if (el.kind === 'video') return '[视频]';
      if (el.kind === 'ptt') return '[语音]';
      if (el.kind === 'reply') return '[回复]';
      return '';
    })
    .filter(Boolean)
    .join(' ')
    .trim();
}

function detectModality(elements: Element[]): 'text' | 'voice' {
  return elements.some((el) => el.kind === 'ptt') ? 'voice' : 'text';
}

/** wav 时长（ms）：decodeSilkToWavFile 输出 16k 单声道 16-bit PCM。读不到返回 0。 */
function wavDurationMs(path: string): number {
  try {
    const bytes = statSync(path).size;
    return Math.max(0, Math.round(((bytes - 44) / (16000 * 2)) * 1000));
  } catch {
    return 0;
  }
}

/**
 * 给一条候选参考音频打质量分（越高越适合做语音克隆参考）。
 * - 时长：3~10s 最佳，过短/过长扣分（克隆参考太短音色不稳、太长易被截）。
 * - waveform：按相对振幅算「有声占比」（避开大段静音/停顿/喘气）；scale 无关（按本条最大值归一）。
 * - 文本：太短（1 字）信息不足扣分。
 */
function scoreVoiceClip(waveform: Uint8Array | undefined, durationMs: number, text: string): number {
  const sec = durationMs / 1000;
  const durScore = sec < 1.5 || sec > 25 ? 0.1 : sec < 3 ? 0.5 : sec <= 10 ? 1 : sec <= 15 ? 0.7 : 0.4;
  let ampScore = 0.5;
  if (waveform && waveform.length >= 4) {
    let max = 1;
    for (const b of waveform) if (b > max) max = b;
    let voiced = 0;
    for (const b of waveform) if (b / max > 0.2) voiced += 1;
    ampScore = voiced / waveform.length;
  }
  const len = text.trim().length;
  const textScore = len < 2 ? 0.2 : len <= 40 ? 1 : 0.7;
  return durScore * 0.5 + ampScore * 0.35 + textScore * 0.15;
}

/** 从候选里挑 Top-K 高质量参考音频（best-first），过滤太短/无文本的。 */
function selectRefClips(candidates: VoiceClipCandidate[]): AgentLabVoiceRefClip[] {
  return [...candidates]
    .filter((c) => c.text.trim().length >= 2 && c.durationMs >= 1200)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((c) => ({ path: c.path, text: c.text, durationMs: c.durationMs }));
}

function profileName(profile: UserProfile | null, fallback: string): string {
  return profile?.remark || profile?.nick || profile?.uin?.toString() || fallback;
}

/** 给没有 md5 的素材生成稳定缓存名。 */
function hashKey(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** 读本地图片 → data URL（按文件头猜 mime），失败返回 null。 */
function imageToDataUrl(path: string): string | null {
  try {
    const buf = readFileSync(path);
    if (buf.length < 4) return null;
    let mime = 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
    else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) mime = 'image/gif';
    else if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export class AgentLabService extends EventEmitter {
  private readonly store: AgentLabStore;
  private readonly usage: TokenUsageStore;
  private readonly conversations: ConversationStore;
  private readonly memories: MemoryStore;
  private readonly notes: NotesStore;
  // 群聊数据底座（M1「接口优先 + JSON 先兑现」）。引擎与路由通过 AgentLab*Store
  // 接口消费；将来换 SQLite 后端时只替换这两行的具体实现。
  private readonly groups: AgentLabGroupStore;
  private readonly relations: AgentLabRelationStore;
  /** 群聊记忆蒸馏节流计数（key = `personaId aboutId`，每 6 次互动蒸一次）。 */
  private readonly groupMemoryCounter = new Map<string, number>();
  private readonly logger = getLogger().child({ scope: 'agentlab' });
  /** 运行时对话引擎（下沉自本类，桌面与导出 bot 共用）。 */
  private readonly runtime: AgentRuntime;

  constructor(
    private readonly session: AccountSession,
    private readonly rootDir: string,
    private readonly resolveEndpoint: EndpointResolver,
    private readonly media?: AgentLabMediaDeps,
    /** 与 AssistantService 共享的 token 记账 / 对话存储（不传则自建，按账号隔离）。 */
    usageStore?: TokenUsageStore,
    conversationStore?: ConversationStore,
    /** 语音合成（克隆体发语音 / 语音克隆）。缺失则不发语音。 */
    private readonly tts?: AgentLabTtsDeps,
  ) {
    super();
    this.store = new AgentLabStore(rootDir);
    this.usage = usageStore ?? new TokenUsageStore(join(rootDir, 'usage.json'));
    this.conversations = conversationStore ?? new ConversationStore(join(rootDir, 'conversations.json'));
    this.memories = new MemoryStore(join(rootDir, 'memories.json'));
    this.notes = new NotesStore(join(rootDir, 'notes.json'));
    this.groups = new JsonGroupStore(join(rootDir, 'groups.json'));
    this.relations = new JsonRelationStore(join(rootDir, 'relations.json'));

    // 运行时对话引擎下沉到 @weq/agentlab 的 AgentRuntime（桌面与导出 bot 共用同一套）。
    // 把桌面侧依赖注入进去：现有 store + TTS（抽象成 TtsPort）+ 登录账号 uin 作为 selfId。
    const ttsPort: TtsPort | undefined = tts
      ? {
          getCapabilities: (id) => {
            const p = tts.getProvider(id);
            return p ? tts.service.capabilities(p.vendor) : null;
          },
          synthesize: (id, text, opts) => {
            const p = tts.getProvider(id);
            if (!p) throw new Error(`TTS provider 不存在: ${id}`);
            return tts.service.synthesize(p, text, opts);
          },
        }
      : undefined;
    this.runtime = new AgentRuntime({
      rootDir,
      store: this.store,
      endpoints: this.resolveEndpoint,
      usage: this.usage,
      conversations: this.conversations,
      memories: this.memories,
      notes: this.notes,
      relations: this.relations,
      selfId: String(this.session.context.uin),
      tts: ttsPort,
      logger: this.logger,
    });
  }

  /** 对话反思笔记（前端「记忆/画像」灯箱可选展示）。 */
  getNotes(personaId: string): AgentLabPersonaNotes {
    return this.notes.get(personaId);
  }

  clearNotes(personaId: string): void {
    this.notes.clear(personaId);
  }

  /** 克隆体对「对方（用户）」的记忆（前端「记忆/画像」灯箱用）。 */
  getMemories(personaId: string): import('@weq/agentlab').AgentLabMemoryItem[] {
    return this.memories.get(personaId);
  }

  forgetMemory(personaId: string, memoryId: string): void {
    this.memories.remove(personaId, memoryId);
  }

  clearMemories(personaId: string): void {
    this.memories.clear(personaId);
  }

  // ── 群聊（多克隆体）——M1 数据底座对上层暴露的最小 CRUD ──────────────────
  // M2 的 tRPC 路由与群聊引擎在此之上搭建。这里只做存储编排，不含意愿/关系更新逻辑。

  /** 「我」在群里的成员 id（用账号 uin，便于将来 napcat 导出对齐真实 QQ 号）。 */
  private selfMemberId(): string {
    return String(this.session.context.uin);
  }

  /**
   * 新建群聊：拉入若干已训练克隆体 + 「我」自己。personaIds 里查不到的克隆体会被跳过。
   * 返回创建好的群（含成员）。
   */
  createGroup(input: { name: string; personaIds: string[] }): {
    group: AgentLabGroup;
    members: AgentLabGroupMember[];
  } {
    const now = Date.now();
    const id = `group-${now}-${createHash('sha1').update(input.name + now).digest('hex').slice(0, 8)}`;
    const ownerId = this.selfMemberId();
    const group = this.groups.createGroup({ id, name: input.name.trim() || '未命名群聊', ownerId, now });

    const members: AgentLabGroupMember[] = [
      { groupId: id, memberId: ownerId, kind: 'user', displayName: '我', joinedAt: now },
    ];
    for (const personaId of input.personaIds) {
      const persona = this.store.getPersona(personaId)?.persona;
      if (!persona) continue;
      members.push({
        groupId: id,
        memberId: personaId,
        kind: 'persona',
        displayName: persona.name,
        joinedAt: now,
      });
    }
    this.groups.setMembers(id, members);

    // 关系初值（M4）：克隆体是从「和我聊天」的真实语料蒸出来的，所以它对「我」自带一点熟络；
    // 对群里其他克隆体则是初次见面的中性关系。之后随互动动态升降。
    const personaIds = members.filter((m) => m.kind === 'persona').map((m) => m.memberId);
    for (const pid of personaIds) {
      this.relations.upsert(makeBaseRelation(pid, ownerId, 'user', now, { affinity: 62, familiarity: 45 }));
      for (const other of personaIds) {
        if (other === pid) continue;
        this.relations.upsert(makeBaseRelation(pid, other, 'persona', now));
      }
    }
    return { group, members };
  }

  listGroups(): AgentLabGroup[] {
    return this.groups.listGroups(this.selfMemberId());
  }

  getGroupDetail(groupId: string): { group: AgentLabGroup; members: AgentLabGroupMember[] } | null {
    const group = this.groups.getGroup(groupId);
    if (!group) return null;
    return { group, members: this.groups.listMembers(groupId) };
  }

  renameGroup(groupId: string, name: string): void {
    this.groups.renameGroup(groupId, name.trim() || '未命名群聊', Date.now());
  }

  deleteGroup(groupId: string): void {
    this.groups.deleteGroup(groupId);
  }

  addGroupMember(groupId: string, personaId: string): void {
    const persona = this.store.getPersona(personaId)?.persona;
    if (!persona) return;
    this.groups.addMember({
      groupId,
      memberId: personaId,
      kind: 'persona',
      displayName: persona.name,
      joinedAt: Date.now(),
    });
  }

  removeGroupMember(groupId: string, memberId: string): void {
    // 不允许把「我」踢出群。
    if (memberId === this.selfMemberId()) return;
    this.groups.removeMember(groupId, memberId);
  }

  /** 群历史消息（前端 seed / 引擎上下文用）。 */
  getGroupMessages(groupId: string, limit?: number): AgentLabGroupMessage[] {
    return this.groups.listMessages(groupId, limit);
  }

  clearGroupMessages(groupId: string): void {
    this.groups.clearMessages(groupId);
  }

  /** 某克隆体对某成员的关系态（M4 起随互动更新；M1 可能为空 = 尚未建立）。 */
  getRelation(subjectPersonaId: string, objectId: string): AgentLabRelation | null {
    return this.relations.get(subjectPersonaId, objectId);
  }

  private groupMsgId(groupId: string, senderId: string, ts: number, text: string): string {
    return createHash('sha1').update(`${groupId}:${senderId}:${ts}:${text}`).digest('hex').slice(0, 16);
  }

  /**
   * 一段互动后更新「克隆体 → 说话人」的关系态（M4）。fire-and-forget：
   * 每次互动熟悉度 +2（纯机械）；每 5 次互动做一次 LLM 情感打分调 affinity/mood（节流成本）。
   */
  private updateRelationAfterExchange(
    subjectPersonaId: string,
    personaName: string,
    objectId: string,
    objectKind: 'user' | 'persona',
    exchange: string,
    endpoint: AgentLabEndpoint,
  ): void {
    void (async () => {
      try {
        const prev = this.relations.get(subjectPersonaId, objectId);
        const nextCount = (prev?.interactionCount ?? 0) + 1;
        const delta: { familiarity: number; affinity?: number; mood?: number } = { familiarity: 2 };
        if (nextCount % 5 === 0) {
          const s = await scoreInteractionSentiment(endpoint, personaName, exchange);
          delta.affinity = s.affinityDelta;
          delta.mood = s.moodDelta;
        }
        this.relations.applyDelta(subjectPersonaId, objectId, objectKind, delta, Date.now());
      } catch {
        /* 关系更新失败不影响聊天 */
      }
    })();
  }

  /**
   * 从「某个克隆体的视角」把群历史渲染成 chat 轮次：自己发的 = assistant，
   * 别人发的 = user 且带「名字」前缀（让模型分得清多个说话人）。M2 用现有 1:1 生成
   * 管线跑群聊的过渡手法——真正的群感知 prompt 在 M3+ 再做。
   */
  private renderGroupHistoryFor(
    personaId: string,
    members: AgentLabGroupMember[],
    messages: AgentLabGroupMessage[],
    limit = 16,
  ): AgentLabChatTurn[] {
    const nameById = new Map(members.map((m) => [m.memberId, m.displayName]));
    return messages.slice(-limit).map((m) => {
      if (m.senderId === personaId) return { role: 'assistant', text: m.text };
      const name = nameById.get(m.senderId) ?? '某人';
      return { role: 'user', text: `「${name}」：${m.text}` };
    });
  }

  /** 单轮群聊最多引发几轮连锁（用户一句话 → 克隆体接话 → 别人再接…）。 */
  private static readonly GROUP_MAX_CHAIN_DEPTH = 3;
  /** 单轮群聊克隆体总回复条数硬上限（防刷屏 / 烧 token）。 */
  private static readonly GROUP_MAX_REPLIES_PER_TURN = 8;

  /**
   * 群聊引擎（M6 自主互动）：一条消息进来 → 逐轮连锁扇出。
   * - 第 0 轮：克隆体反应「用户这条」（被 @ 定向必回；否则各过意愿闸）。
   * - 后续轮：克隆体反应「上一轮别人新说的话」，形成你来我往的真群氛围。
   * 刹车：连锁深度上限 + 每轮总回复预算 + 反连续两轮开口 + 相似度打断（防复读）+
   * 意愿闸的存在感/冷却惩罚。某轮没人接话就收摊。onMessage 逐条流式回调。
   */
  async sendGroupMessage(
    input: { groupId: string; text: string; mentions?: string[] },
    onMessage: (message: AgentLabGroupMessage) => void,
  ): Promise<{ messages: AgentLabGroupMessage[] }> {
    const detail = this.getGroupDetail(input.groupId);
    if (!detail) throw new Error('找不到群聊');
    const { members } = detail;
    const selfId = this.selfMemberId();
    const emitted: AgentLabGroupMessage[] = [];
    const record = (msg: AgentLabGroupMessage): void => {
      this.groups.appendMessage(msg);
      emitted.push(msg);
      onMessage(msg);
    };

    // 1) 记录并推送用户这条消息。
    const now = Date.now();
    const mentions = input.mentions && input.mentions.length > 0 ? input.mentions : undefined;
    const userMsg: AgentLabGroupMessage = {
      id: this.groupMsgId(input.groupId, selfId, now, input.text),
      groupId: input.groupId,
      senderId: selfId,
      senderKind: 'user',
      text: input.text,
      ts: now,
      mentions,
    };
    record(userMsg);

    const personaMembers = members.filter((m) => m.kind === 'persona');
    const mentionSet = new Set(mentions ?? []);
    const directed = mentionSet.size > 0;

    // 2) 逐轮连锁。每个候选克隆体各自用 LLM 决策「要不要开口」（带上下文/关系/记忆/性格），
    //    别人之间的对话/没提到自己就潜水——这才是鲁棒的对话边界判断。@必回走快捷路。
    let totalReplies = 0;
    let prevRoundSpeakers = new Set<string>();
    const nameById = new Map(members.map((m) => [m.memberId, m.displayName]));
    for (let round = 0; round < AgentLabService.GROUP_MAX_CHAIN_DEPTH; round += 1) {
      if (totalReplies >= AgentLabService.GROUP_MAX_REPLIES_PER_TURN) break;
      const roundBase = this.groups.listMessages(input.groupId);
      const recent8 = roundBase.slice(-8);

      // 本轮候选：第 0 轮定向（@）则只有被 @ 的；否则排除上一轮刚开过口的（防连续刷屏兜底）。
      const candidateMembers =
        round === 0 && directed
          ? personaMembers.filter((m) => mentionSet.has(m.memberId))
          : personaMembers.filter((m) => !prevRoundSpeakers.has(m.memberId));
      if (candidateMembers.length === 0) break;

      // 每个候选并发：定位触发消息 → @必回快捷 / 否则 LLM 决策 → 决定回则生成落库。
      const results = await Promise.all(
        candidateMembers.map(async (member) => {
          const rec = this.store.getPersona(member.memberId);
          if (!rec?.persona.models?.chat) return { memberId: member.memberId, count: 0 };
          let trigger: AgentLabGroupMessage | null = null;
          for (let i = roundBase.length - 1; i >= 0; i -= 1) {
            const m = roundBase[i]!;
            if (m.senderId !== member.memberId) {
              trigger = m;
              break;
            }
          }
          if (!trigger) return { memberId: member.memberId, count: 0 };

          const willing = rec.persona.willing;
          const mustReply = willing?.mustReplyOnMention !== false;
          const mentioned = (trigger.mentions ?? []).includes(member.memberId);
          const ctx = { personaId: member.memberId, scope: 'chat' as const };
          const chatEndpoint = this.resolveWithUsage(rec.persona.models.chat, 'chat', ctx);

          // @ 且必回 → 跳过决策；否则让 TA 自己带上下文判断要不要开口。
          if (!(mentioned && mustReply)) {
            const rel = this.relations.get(member.memberId, trigger.senderId);
            const decision = await decideGroupReply(chatEndpoint, {
              personaName: rec.persona.name,
              tone: rec.persona.profile?.card?.tone || rec.persona.profile?.styleSummary,
              transcript: this.renderNeutralTranscript(members, roundBase, 12),
              currentSpeaker: trigger.senderKind === 'user' ? '我' : nameById.get(trigger.senderId) ?? '某人',
              currentText: trigger.text,
              relationNote: rel ? describeRelationTone(rel) : undefined,
              memories: this.memories
                .getAbout(member.memberId, [trigger.senderId], trigger.senderKind === 'user')
                .slice(0, 5)
                .map((m) => m.text),
              dispositionHint: this.willingDisposition(willing?.level),
              crowdedHint: this.crowdedHint(recent8, member.memberId),
            });
            if (!decision.reply) return { memberId: member.memberId, count: 0 };
          }

          const delayMs = 300 + Math.round(Math.random() * 500);
          const count = await this.respondInGroup(
            input.groupId,
            members,
            rec.persona,
            rec.pairs,
            member,
            trigger,
            roundBase,
            delayMs,
            record,
          );
          return { memberId: member.memberId, count };
        }),
      );
      const roundSpeakers = new Set(results.filter((r) => r.count > 0).map((r) => r.memberId));
      totalReplies += results.reduce((sum, r) => sum + r.count, 0);
      if (roundSpeakers.size === 0) break; // 没人接话 / 都被相似度拦下 → 收摊
      prevRoundSpeakers = roundSpeakers;
    }
    return { messages: emitted };
  }

  /** 群历史渲染成中性第三人称文字（谁说了啥），供发言决策用；单条截断、窗口有界。 */
  private renderNeutralTranscript(members: AgentLabGroupMember[], messages: AgentLabGroupMessage[], limit: number): string {
    const nameById = new Map(members.map((m) => [m.memberId, m.displayName]));
    return messages
      .slice(-limit)
      .map((m) => `${m.senderKind === 'user' ? '我' : nameById.get(m.senderId) ?? '某人'}: ${m.text.slice(0, 80)}`)
      .join('\n');
  }

  /** 意愿档位 → 性格倾向提示（喂给发言决策）。 */
  private willingDisposition(level?: number): string {
    if (level === undefined) return '';
    if (level >= 70) return '你性格比较爱说话、爱凑热闹，遇到能接的话就想插两句。';
    if (level <= 30) return '你性格偏高冷、不太主动接话，多数时候在潜水，只有真戳到你才开口。';
    return '';
  }

  /** 存在感/热闹度提示：自己最近说太多、或群里太吵，就提醒别硬刷屏。 */
  private crowdedHint(recent: AgentLabGroupMessage[], memberId: string): string {
    if (recent.length === 0) return '';
    const mine = recent.filter((m) => m.senderId === memberId).length;
    if (mine / recent.length > 0.5) return '你最近已经连着说了好几条了，注意别刷屏，没必要就歇一歇。';
    const botShare = recent.filter((m) => m.senderKind === 'persona').length / recent.length;
    if (botShare > 0.7) return '群里最近有点吵（大家都在刷屏），不是特别想说就别接了。';
    return '';
  }

  /**
   * 让一个克隆体针对某条触发消息在群里发言：生成 → 相似度过滤 → 逐条揭示落库 → 更新关系。
   * 返回实际落库的消息条数（0 = 被相似度拦下 / 生成失败）。
   */
  private async respondInGroup(
    groupId: string,
    members: AgentLabGroupMember[],
    persona: AgentLabPersona,
    pairs: AgentLabStoredPair[],
    member: AgentLabGroupMember,
    trigger: AgentLabGroupMessage,
    roundBase: AgentLabGroupMessage[],
    delayMs: number,
    record: (message: AgentLabGroupMessage) => void,
  ): Promise<number> {
    try {
      const ctx = { personaId: member.memberId, scope: 'chat' as const };
      const chatEndpoint = this.resolveWithUsage(persona.models.chat, 'chat', ctx);
      const embeddingEndpoint = persona.models.embedding
        ? this.resolveWithUsage(persona.models.embedding, 'embedding', ctx)
        : null;
      // 历史 = 触发消息之前的群消息（触发消息作为 input 单独传）。
      const idx = roundBase.findIndex((m) => m.id === trigger.id);
      const prior = idx >= 0 ? roundBase.slice(0, idx) : roundBase;
      const history = this.renderGroupHistoryFor(member.memberId, members, prior);
      const rel = this.relations.get(member.memberId, trigger.senderId);
      const relationNote = rel ? describeRelationTone(rel) : undefined;
      // M5：只召回「关于触发者」的记忆（防串人）。对方是「我」时连旧的无标签记忆一并带上。
      const memories = this.memories.getAbout(member.memberId, [trigger.senderId], trigger.senderKind === 'user');
      // 触发者是别的克隆体时，给输入带上「名字」前缀，让 TA 知道是谁在跟自己说话。
      const triggerName = members.find((m) => m.memberId === trigger.senderId)?.displayName ?? '某人';
      const inputText = trigger.senderKind === 'user' ? trigger.text : `「${triggerName}」：${trigger.text}`;

      await sleep(delayMs); // 越想回越快开口
      const { renderedTurns } = await this.runtime.generatePersonaTurns(persona, pairs, {
        chatEndpoint,
        embeddingEndpoint,
        history,
        input: inputText,
        now: Date.now(),
        relationNote,
        memories,
      });

      // 相似度打断：跳过和最近消息几乎重复的内容（防「复读机」/ 互相抄）。
      const recentTexts = roundBase.slice(-6).map((m) => m.text);
      let recorded = 0;
      for (const text of renderedTurns) {
        if (this.tooSimilar(text, recentTexts)) continue;
        if (recorded > 0) await sleep(Math.min(1400, 300 + text.length * 45));
        record({
          id: this.groupMsgId(groupId, member.memberId, Date.now(), text),
          groupId,
          senderId: member.memberId,
          senderKind: 'persona',
          text,
          ts: Date.now(),
        });
        recentTexts.push(text);
        recorded += 1;
      }
      if (recorded > 0) {
        const exchange = `对方：${trigger.text}\n你：${renderedTurns.join(' / ')}`;
        this.updateRelationAfterExchange(member.memberId, persona.name, trigger.senderId, trigger.senderKind, exchange, chatEndpoint);
        // M5：节流地蒸馏「关于触发者」的记忆（带 aboutId 防串人 + 有向量时嵌入）。不阻塞。
        this.maybeDistillGroupMemory(
          member.memberId,
          persona.name,
          trigger.senderId,
          trigger.senderKind,
          [
            { role: 'user', text: trigger.text },
            { role: 'assistant', text: renderedTurns.join(' / ') },
          ],
          chatEndpoint,
          embeddingEndpoint,
        );
      }
      return recorded;
    } catch {
      return 0; // 单个克隆体失败不影响其它人
    }
  }

  /**
   * 群聊记忆蒸馏（M5）：每 6 次「和某人的互动」蒸馏一次关于 TA 的新记忆，带 aboutId
   * 防串人；配了向量模型就顺带嵌入以便语义召回。fire-and-forget，失败静默。
   */
  private maybeDistillGroupMemory(
    personaId: string,
    personaName: string,
    aboutId: string,
    aboutKind: 'user' | 'persona',
    convo: Array<{ role: 'user' | 'assistant'; text: string }>,
    chatEndpoint: AgentLabEndpoint,
    embeddingEndpoint: AgentLabEndpoint | null,
  ): void {
    const key = `${personaId} ${aboutId}`;
    const n = (this.groupMemoryCounter.get(key) ?? 0) + 1;
    this.groupMemoryCounter.set(key, n);
    if (n % 6 !== 0) return;
    void (async () => {
      try {
        const known = this.memories
          .getAbout(personaId, [aboutId], aboutKind === 'user')
          .map((m) => m.text)
          .slice(-40);
        const fresh = await distillMemories(chatEndpoint, personaName, convo, known);
        if (fresh.length === 0) return;
        let embeddings: Array<number[] | undefined> | undefined;
        if (embeddingEndpoint) {
          try {
            embeddings = await embedTexts(embeddingEndpoint, fresh);
          } catch {
            /* 嵌入失败就退化成关键词召回 */
          }
        }
        this.memories.add(personaId, fresh, Date.now(), { aboutId, aboutKind }, embeddings);
      } catch {
        /* 记忆蒸馏失败不影响聊天 */
      }
    })();
  }

  /** 判断一条文本是否和最近消息几乎重复（防复读）。短消息（表情/单字）不查重。 */
  private tooSimilar(text: string, recent: string[]): boolean {
    const norm = (s: string): string => s.replace(/\s/g, '').toLowerCase();
    const a = norm(text);
    if (a.length < 4) return false;
    for (const r of recent) {
      const b = norm(r);
      if (b.length < 4) continue;
      if (a === b) return true;
      if (a.length >= 6 && (b.includes(a) || a.includes(b))) return true;
    }
    return false;
  }

  /** token 用量统计（主页图表用）。 */
  getTokenStats(): TokenStats {
    return this.usage.getStats();
  }

  /** 与某克隆体的历史对话（持久化，刷新不丢）。 */
  getConversation(personaId: string): ConversationTurn[] {
    return this.conversations.get(personaId);
  }

  clearConversation(personaId: string): void {
    this.conversations.clear(personaId);
  }

  /** 解析端点并挂上 token 记账回调（按任务类型 + 归属 persona/场景）。 */
  private resolveWithUsage(
    ref: AgentLabModelRef,
    kind: 'chat' | 'embedding' | 'vision',
    ctx: { personaId?: string; scope: 'build' | 'chat' | 'assistant' },
  ): AgentLabEndpoint {
    const ep = this.resolveEndpoint(ref);
    return {
      ...ep,
      kind,
      onUsage: (u: AgentLabUsage) =>
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

  /** Emit one build-progress event (consumed by the onAgentLabBuildProgress subscription). */
  private emitProgress(personaId: string, phase: string, percent: number, extra?: { done?: boolean; error?: string }): void {
    this.emit('build-progress', {
      personaId,
      phase,
      percent: Math.min(100, Math.max(0, Math.round(percent))),
      ...extra,
    } satisfies AgentLabBuildProgress);
  }

  listPersonas(): AgentLabPersona[] {
    return this.store.listPersonas();
  }

  getPersona(personaId: string): AgentLabPersona | null {
    return this.store.getPersona(personaId)?.persona ?? null;
  }

  /**
   * 按 md5 解析某克隆体的自定义表情包本地路径（供 weq-media://sticker 协议读取）。
   * 找不到 persona / 表情 / 文件不存在时返回 null。
   */
  /**
   * 按 id 解析某条合成语音的本地路径（供 weq-media://agentvoice 协议读取）。
   * id 必须是安全 basename（仅 hex + .mp3/.wav），防目录逃逸。
   */
  getAgentVoicePath(id: string): string | null {
    return this.runtime.getAgentVoicePath(id);
  }

  getStickerPath(personaId: string, md5: string): string | null {
    const persona = this.store.getPersona(personaId)?.persona;
    if (!persona) return null;
    const sticker = persona.stickers?.find((s) => s.md5 === md5);
    if (!sticker?.localPath) return null;
    return existsSync(sticker.localPath) ? sticker.localPath : null;
  }

  /** 给前端「查看画像参数」用：persona + 抽样问答对（不返回 embedding，省带宽）。 */
  getPersonaDetail(
    personaId: string,
  ): { persona: AgentLabPersona; pairs: Array<{ prompt: string; reply: string }> } | null {
    const record = this.store.getPersona(personaId);
    if (!record) return null;
    const pairs = record.pairs.slice(0, 40).map((pair) => ({ prompt: pair.prompt, reply: pair.reply }));
    return { persona: record.persona, pairs };
  }

  deletePersona(personaId: string): boolean {
    this.memories.clear(personaId);
    this.conversations.clear(personaId);
    this.notes.clear(personaId);
    return this.store.deletePersona(personaId);
  }

  /** 增量更新克隆体的可编辑字段（额外提示 / 名称 / 语音克隆开关 / 语音绑定）。 */
  updatePersona(
    personaId: string,
    patch: {
      name?: string;
      customPrompt?: string;
      voiceCloneEnabled?: boolean;
      voice?: AgentLabVoiceBinding | null;
      willing?: AgentLabWillingConfig | null;
    },
  ): AgentLabPersona | null {
    const record = this.store.getPersona(personaId);
    if (!record) return null;
    const persona = record.persona;
    if (patch.name !== undefined) persona.name = patch.name.trim() || persona.name;
    if (patch.customPrompt !== undefined) persona.customPrompt = patch.customPrompt.trim() || undefined;
    if (patch.voiceCloneEnabled !== undefined) persona.voiceCloneEnabled = patch.voiceCloneEnabled;
    if (patch.voice !== undefined) persona.voice = patch.voice ?? undefined;
    if (patch.willing !== undefined) persona.willing = patch.willing ?? undefined;
    persona.updatedAt = Date.now();
    this.store.savePersona(record);
    return persona;
  }

  // ── Thing 1：语料采集 / 媒体增强 的私有步骤 ─────────────────────────────────

  /**
   * 翻页拉私聊（替代"取最近 N 条"），返回 oldest-first，受 cap 限制。
   * capHit=true 表示是因为撞到 cap 才停（历史里还有更老的消息没拉），供语音兜底判断。
   */
  private async collectC2cMessages(
    part: C2cPartition,
    cap: number,
  ): Promise<{ msgs: C2cMsg[]; capHit: boolean }> {
    const PAGE = 500;
    const out: C2cMsg[] = [];
    let capHit = false;
    let page = await this.session.c2cMsgs.listLatest(part, PAGE); // newest-first
    while (page.length > 0) {
      out.push(...page);
      if (out.length >= cap) {
        capHit = true;
        break;
      }
      const oldest = page[page.length - 1];
      if (!oldest) break;
      const next = await this.session.c2cMsgs.listBefore(part, oldest.msgSeq, PAGE);
      if (next.length === 0) break;
      page = next;
    }
    return { msgs: out.slice(0, cap).reverse(), capHit };
  }

  /**
   * 语音参考兜底（group 模式专用）：当总消息上限把语料截断、收集到的语料里一条可用语音都没有时，
   * 单独把整个私聊历史再翻一遍——**只看好友的语音、只为语音克隆攒参考音频**，不进语料、不做问答对。
   * 攒够 Top-K 条（selectRefClips 也就取 5 条）即停，避免无谓转录全历史。
   */
  private async salvageVoiceClips(
    part: C2cPartition,
    selfUin: string,
    voiceClips: VoiceClipCandidate[],
  ): Promise<void> {
    if (!this.media?.transcribe || !(this.media.voiceReady?.() ?? false)) return;
    const PAGE = 500;
    let transcribed = 0;
    let scanned = 0;
    let page = await this.session.c2cMsgs.listLatest(part, PAGE);
    while (
      page.length > 0 &&
      transcribed < VOICE_TRANSCRIBE_CAP &&
      voiceClips.length < VOICE_REF_NEED &&
      scanned < C2C_SAFETY_CAP
    ) {
      for (const msg of page) {
        scanned += 1;
        if (msg.senderUin.toString() === selfUin) continue; // 只要好友（assistant）的语音
        if (!msg.elements.some((el) => el.kind === 'ptt')) continue;
        const res = await this.transcribePtt(msg.elements, Number(msg.sendTime) * 1000);
        if (!res.spoken || res.voiceChanged || !res.wavPath) continue;
        transcribed += 1;
        const durationMs = res.durationMs ?? 0;
        voiceClips.push({
          path: res.wavPath,
          text: res.spoken,
          durationMs,
          score: scoreVoiceClip(res.waveform, durationMs, res.spoken),
        });
        if (voiceClips.length >= VOICE_REF_NEED || transcribed >= VOICE_TRANSCRIBE_CAP) break;
      }
      const oldest = page[page.length - 1];
      if (!oldest) break;
      const next = await this.session.c2cMsgs.listBefore(part, oldest.msgSeq, PAGE);
      if (next.length === 0) break;
      page = next;
    }
  }

  /**
   * 群聊语音打捞（group 模式）：去好友所在群里找 **TA 本人** 的语音，转录留 wav 攒克隆参考。
   * 语音不分私聊/群聊、一视同仁——私聊没攒够时就来群里补。只收好友本人、排除变声，
   * 攒够 Top-K（VOICE_REF_NEED）即停，遍历上限沿用群补采那套（GROUP_MAX 群 × PER_GROUP_SCAN_CAP）。
   */
  private async salvageGroupVoiceClips(
    targetUid: string,
    voiceClips: VoiceClipCandidate[],
  ): Promise<void> {
    if (!this.media?.transcribe || !(this.media.voiceReady?.() ?? false)) return;
    const groups = await this.session.groupMembers.listUserGroups(targetUid, 50);
    const picked = [...groups].sort((a, b) => b.lastSpeakTime - a.lastSpeakTime).slice(0, GROUP_MAX);
    let transcribed = 0;
    for (const g of picked) {
      if (voiceClips.length >= VOICE_REF_NEED || transcribed >= VOICE_TRANSCRIBE_CAP) break;
      const groupCode = g.groupCode.toString();
      let scanned = 0;
      let beforeSeq: bigint | null = null;
      while (
        scanned < PER_GROUP_SCAN_CAP &&
        voiceClips.length < VOICE_REF_NEED &&
        transcribed < VOICE_TRANSCRIBE_CAP
      ) {
        const page: GroupMsg[] =
          beforeSeq === null
            ? await this.session.groupMsgs.listLatest(groupCode, 500)
            : await this.session.groupMsgs.listBefore(groupCode, beforeSeq, 500);
        if (page.length === 0) break;
        scanned += page.length;
        const oldest = page[page.length - 1];
        if (!oldest) break;
        beforeSeq = oldest.msgSeq;
        for (const m of page) {
          if (m.senderUid !== targetUid) continue; // 只要好友本人的语音
          if (!m.elements.some((el) => el.kind === 'ptt')) continue;
          const res = await this.transcribePtt(m.elements, Number(m.sendTime) * 1000);
          if (!res.spoken || res.voiceChanged || !res.wavPath) continue;
          transcribed += 1;
          const durationMs = res.durationMs ?? 0;
          voiceClips.push({
            path: res.wavPath,
            text: res.spoken,
            durationMs,
            score: scoreVoiceClip(res.waveform, durationMs, res.spoken),
          });
          if (voiceClips.length >= VOICE_REF_NEED || transcribed >= VOICE_TRANSCRIBE_CAP) break;
        }
      }
    }
  }

  /**
   * 把私聊原始消息映射成语料消息；遇到语音且配了转录模型时，逐条转录（至多
   * VOICE_TRANSCRIBE_CAP 条）并把 `[语音]` 占位替换成 `[语音]<文本>`。
   */
  private async mapC2cMessages(
    rawMsgs: C2cMsg[],
    selfUin: string,
    selfName: string,
    peerName: string,
    voiceClips: VoiceClipCandidate[],
  ): Promise<AgentLabMessage[]> {
    const canTranscribe = !!this.media?.transcribe && (this.media.voiceReady?.() ?? false);
    let transcribed = 0;
    const out: AgentLabMessage[] = [];
    for (const msg of rawMsgs) {
      const role = msg.senderUin.toString() === selfUin ? 'user' : 'assistant';
      const ts = Number(msg.sendTime) * 1000;
      const modality = detectModality(msg.elements);
      let text = textFromElements(msg.elements);
      if (modality === 'voice' && canTranscribe && transcribed < VOICE_TRANSCRIBE_CAP) {
        const res = await this.transcribePtt(msg.elements, ts);
        if (res.spoken) {
          text = text.includes('[语音]') ? text.replace('[语音]', `[语音]${res.spoken}`) : `[语音]${res.spoken}`;
          transcribed += 1;
          // 收集 TA（好友 = assistant 角色）的干净语音做克隆参考：**排除变声**，按 waveform 质量打分。
          if (role === 'assistant' && res.wavPath && !res.voiceChanged) {
            const durationMs = res.durationMs ?? 0;
            voiceClips.push({
              path: res.wavPath,
              text: res.spoken,
              durationMs,
              score: scoreVoiceClip(res.waveform, durationMs, res.spoken),
            });
          }
        }
      }
      if (!text) continue;
      out.push({ role, text, ts, senderName: role === 'user' ? selfName : peerName, modality });
    }
    return out;
  }

  /**
   * 定位/下载一条语音的 silk → 转录文本（顺手留一份 wav，供语音克隆参考）。
   * 返回转录文本 + wav 路径 + 时长 + 变声标志 + waveform（后者用于挑高质量参考音频）。
   */
  private async transcribePtt(
    elements: Element[],
    tsMs: number,
  ): Promise<{ spoken: string | null; wavPath?: string; durationMs?: number; voiceChanged?: boolean; waveform?: Uint8Array }> {
    const media = this.media;
    if (!media?.transcribe) return { spoken: null };
    const ptt = elements.find((el): el is Extract<Element, { kind: 'ptt' }> => el.kind === 'ptt');
    if (!ptt) return { spoken: null };
    let silk = (await media.fileSearch.findFile(tsMs, ptt.fileName, 'ptt')).source;
    if (!silk && ptt.fileToken) {
      silk = await media.mediaDownload.download(ptt.fileToken, {
        ext: '.silk',
        rkeyTypes: [PRIVATE_PTT_RKEY_TYPE, GROUP_PTT_RKEY_TYPE],
      });
    }
    if (!silk) return { spoken: null };
    // 留一份 wav（16k 单声道）供语音克隆当参考音频（best-effort，不阻断转录）。
    let wavPath: string | undefined;
    if (media.decodeSilkToWavFile) {
      const wav = join(this.voiceDir(), `${ptt.md5 || hashKey(ptt.fileName)}.wav`);
      try {
        if (!existsSync(wav)) await media.decodeSilkToWavFile(silk, wav);
        if (existsSync(wav)) wavPath = wav;
      } catch {
        /* ignore wav 留存失败 */
      }
    }
    const durationMs = wavPath ? wavDurationMs(wavPath) : undefined;
    try {
      const r = await media.transcribe(silk);
      const spoken = r.ok && r.text?.trim() ? r.text.trim() : null;
      return { spoken, wavPath, durationMs, voiceChanged: ptt.voiceChanged, waveform: ptt.waveform };
    } catch {
      return { spoken: null, wavPath, durationMs, voiceChanged: ptt.voiceChanged, waveform: ptt.waveform };
    }
  }

  /**
   * 扫消息：累计好友的自定义表情包(pic subType===1) + 系统表情 faceText。
   * 同时维护 lastText（最近一条有意义文本，含自己发的），好友发表情时把它记进该表情的
   * contexts——「TA 发这张前别人/自己说了什么」就是这张表情的真实使用情境（借鉴 CipherTalk）。
   */
  private collectStickersAndFaces(
    rawMsgs: C2cMsg[],
    selfUin: string,
  ): { stickers: Map<string, StickerAccum>; faces: Map<string, number> } {
    const stickers = new Map<string, StickerAccum>();
    const faces = new Map<string, number>();
    let lastText = '';
    const pushContext = (acc: StickerAccum): void => {
      const ctx = lastText.slice(0, STICKER_CONTEXT_CHAR_CAP);
      if (ctx && acc.contexts.length < STICKER_CONTEXT_MAX && !acc.contexts.includes(ctx)) {
        acc.contexts.push(ctx);
      }
    };
    for (const msg of rawMsgs) {
      const isFriend = msg.senderUin.toString() !== selfUin;
      const ts = Number(msg.sendTime) * 1000;
      if (isFriend) {
        for (const el of msg.elements) {
          if (el.kind === 'pic' && el.subType === 1 && el.md5) {
            let cur = stickers.get(el.md5);
            if (cur) {
              cur.count += 1;
            } else {
              cur = {
                md5: el.md5,
                fileName: el.fileName,
                fileToken: el.fileToken,
                originalUrl: el.originalUrl,
                ts,
                count: 1,
                contexts: [],
              };
              stickers.set(el.md5, cur);
            }
            pushContext(cur);
          } else if (el.kind === 'face' && el.faceText) {
            faces.set(el.faceText, (faces.get(el.faceText) ?? 0) + 1);
          }
        }
      }
      // 更新 lastText（含自己和好友的文本，作为下一条表情的上下文）；纯占位/表情消息不更新。
      const text = textFromElements(msg.elements);
      if (isMeaningful(text)) lastText = text;
    }
    return { stickers, faces };
  }

  /** Top 高频表情包 → 本地缓存 + （有 vision 时）解读内容/场景。 */
  private async buildStickerRefs(
    accums: StickerAccum[],
    visionRef: AgentLabModelRef | undefined,
    chatFriendName: string,
    personaId: string,
  ): Promise<AgentLabStickerRef[]> {
    const media = this.media;
    if (!media) return [];
    const top = [...accums].sort((a, b) => b.count - a.count).slice(0, STICKER_CAP);
    let visionEndpoint: AgentLabEndpoint | null = null;
    if (visionRef) {
      try {
        visionEndpoint = this.resolveWithUsage(visionRef, 'vision', { personaId, scope: 'build' });
      } catch {
        visionEndpoint = null;
      }
    }
    const out: AgentLabStickerRef[] = [];
    for (const s of top) {
      let found = (await media.fileSearch.findFile(s.ts, s.fileName, 'emoji')).thumb;
      if (!found && s.fileToken) {
        found = await media.mediaDownload.download(s.fileToken, {
          ext: '.png',
          originalUrl: s.originalUrl,
          rkeyTypes: [PRIVATE_IMAGE_RKEY_TYPE, GROUP_IMAGE_RKEY_TYPE],
        });
      }
      const localPath = found ? this.cacheStickerFile(found, s.md5) : undefined;
      let description = '';
      let scenario = '';
      if (localPath && visionEndpoint) {
        const dataUrl = imageToDataUrl(localPath);
        if (dataUrl) {
          // 用这张表情专属的使用情境作 hint（比全局语料切片精准）。
          const d = await describeSticker(visionEndpoint, chatFriendName, dataUrl, s.contexts.join('\n'));
          description = d.description;
          scenario = d.scenario;
        }
      }
      out.push({
        md5: s.md5,
        fileName: s.fileName,
        localPath,
        cdnToken: s.fileToken,
        count: s.count,
        description,
        scenario,
        contexts: s.contexts,
      });
    }
    return out;
  }

  /**
   * 深层画像 map-reduce：全量历史切块 → 并发 3 块提取部分画像 → 合并。
   * 内部不抛：单块失败跳过、合并失败退回最新一份（近况优先），保证 deep 失败不拖垮 card/fewShots。
   */
  private async extractDeepProfileMapReduce(
    endpoint: AgentLabEndpoint,
    friendName: string,
    turns: AgentLabTurn[],
    personaId: string,
  ): Promise<AgentLabPersonaDeepProfile> {
    const empty: AgentLabPersonaDeepProfile = {
      facts: [],
      relationship: '',
      reactionPatterns: [],
      boundaries: [],
      sharedEvents: [],
    };
    const chunks = renderProfileChunks(turns, friendName);
    if (chunks.length === 0) return empty;

    // 按索引写入保序（merge 提示依赖「越靠后越新」），并发 3 控制时延。
    const parts: Array<AgentLabPersonaDeepProfile | undefined> = new Array(chunks.length);
    let next = 0;
    let done = 0;
    const CONCURRENCY = 3;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
        while (next < chunks.length) {
          const i = next++;
          const chunk = chunks[i];
          if (chunk) {
            try {
              parts[i] = await extractProfileChunk(endpoint, friendName, chunk);
            } catch {
              // 单块失败跳过
            }
          }
          done += 1;
          this.emitProgress(
            personaId,
            `提炼深层画像 (${done}/${chunks.length})`,
            64 + Math.round((done / chunks.length) * 10),
          );
        }
      }),
    );

    const valid = parts.filter((p): p is AgentLabPersonaDeepProfile => !!p);
    if (valid.length === 0) return empty;
    try {
      return await mergeProfileParts(endpoint, friendName, valid);
    } catch {
      return valid[valid.length - 1] ?? empty;
    }
  }

  /** 私聊语料不足时去好友所在群学风格：只取 TA 自己的发言，受多重上限约束。 */
  private async collectGroupStyleMessages(targetUid: string): Promise<AgentLabMessage[]> {
    const groups = await this.session.groupMembers.listUserGroups(targetUid, 50);
    const picked = [...groups].sort((a, b) => b.lastSpeakTime - a.lastSpeakTime).slice(0, GROUP_MAX);
    const out: AgentLabMessage[] = [];
    for (const g of picked) {
      if (out.length >= GROUP_TOTAL_CAP) break;
      const groupCode = g.groupCode.toString();
      let scanned = 0;
      let taken = 0;
      let beforeSeq: bigint | null = null;
      while (scanned < PER_GROUP_SCAN_CAP && taken < PER_GROUP_MSG_CAP && out.length < GROUP_TOTAL_CAP) {
        const page: GroupMsg[] =
          beforeSeq === null
            ? await this.session.groupMsgs.listLatest(groupCode, 500)
            : await this.session.groupMsgs.listBefore(groupCode, beforeSeq, 500);
        if (page.length === 0) break;
        scanned += page.length;
        const oldest = page[page.length - 1];
        if (!oldest) break;
        beforeSeq = oldest.msgSeq;
        for (const m of page) {
          if (m.senderUid !== targetUid) continue;
          const text = textFromElements(m.elements);
          if (!isMeaningful(text)) continue;
          out.push({ role: 'assistant', text, ts: Number(m.sendTime) * 1000, modality: 'text' });
          taken += 1;
          if (taken >= PER_GROUP_MSG_CAP || out.length >= GROUP_TOTAL_CAP) break;
        }
      }
    }
    return out;
  }

  /** 收集若干"语音前后"的对话窗口（已转录），供总结语音使用场景。 */
  private collectVoiceWindows(messages: AgentLabMessage[], friendName: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < messages.length && out.length < 12; i += 1) {
      const m = messages[i];
      if (!m || m.role !== 'assistant') continue;
      if (!m.text.startsWith('[语音]') || m.text.length <= 4) continue; // 只取转录成功的
      const lines: string[] = [];
      const prev = messages[i - 1];
      if (prev) lines.push(`${prev.role === 'user' ? '对方' : friendName}: ${prev.text}`);
      lines.push(`${friendName}: ${m.text}`);
      out.push(lines.join('\n'));
    }
    return out;
  }

  private voiceDir(): string {
    const dir = join(this.rootDir, 'voice');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 复制表情图到 agentlab/stickers/<md5>.png，返回缓存路径（失败返回原路径）。 */
  private cacheStickerFile(src: string, md5: string): string {
    try {
      const dir = join(this.rootDir, 'stickers');
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, `${md5 || hashKey(src)}.png`);
      if (!existsSync(dest)) copyFileSync(src, dest);
      return dest;
    } catch {
      return src;
    }
  }

  /** Public entry: runs the build, emitting build-progress events throughout. */
  async buildFromC2c(input: BuildFromC2cInput): Promise<AgentLabPersona> {
    try {
      const persona = await this.runBuild(input);
      this.emitProgress(input.personaId, '完成', 100, { done: true });
      return persona;
    } catch (error) {
      this.emitProgress(input.personaId, '失败', 100, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async runBuild(input: BuildFromC2cInput): Promise<AgentLabPersona> {
    this.emitProgress(input.personaId, '准备中', 2);
    const usageCtx = { personaId: input.personaId, scope: 'build' as const };
    const chatEndpoint = this.resolveWithUsage(input.models.chat, 'chat', usageCtx);
    const embeddingEndpoint = input.models.embedding
      ? this.resolveWithUsage(input.models.embedding, 'embedding', usageCtx)
      : null;
    const selfUin = this.session.context.uin;
    const selfProfile = await this.session.profileInfo.getProfileByUin(BigInt(selfUin));
    const peerProfile = await this.session.profileInfo.getProfile(input.targetUid);
    const selfName = profileName(selfProfile, selfUin);
    const peerName = profileName(peerProfile, input.targetUid);
    const displayName = input.name?.trim() || peerName;

    const mode = input.mode ?? 'group';
    const part = this.c2cPartition(input.targetUid);
    const canTranscribe = !!this.media?.transcribe && (this.media?.voiceReady?.() ?? false);

    // 1) 私聊语料（翻页拉取，受总消息上限约束；capHit 供后面的语音兜底判断）。
    this.emitProgress(input.personaId, '拉取聊天记录', 8);
    const { msgs: rawMsgs, capHit } = await this.collectC2cMessages(part, input.limit ?? C2C_CORPUS_CAP);

    // 2) 映射成语料（顺手把语音转录成文本，并收集 TA 的干净语音做克隆参考）。
    this.emitProgress(input.personaId, '整理语料 / 转录语音', 28);
    const voiceClips: VoiceClipCandidate[] = [];
    const messages = await this.mapC2cMessages(rawMsgs, selfUin, selfName, peerName, voiceClips);

    // 3) 表情包 + 系统表情白名单（只看好友自己的消息）。
    this.emitProgress(input.personaId, '统计表情', 42);
    const { stickers: stickerAccum, faces } = this.collectStickersAndFaces(rawMsgs, selfUin);
    const systemFaces = [...faces.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, FACE_WHITELIST_CAP)
      .map(([text]) => text);

    // 4) 阈值兜底：**仅 group 模式**且私聊有效语料不足 → 去群里补采风格语料（只学语气，不构成问答对）。
    //    private 模式即便语料不够也不回退群聊（用户明确选择「纯私聊」）。
    const friendMsgCount = messages.filter((m) => m.role === 'assistant' && isMeaningful(m.text)).length;
    const needGroup = mode === 'group' && friendMsgCount < GROUP_SUPPLEMENT_THRESHOLD;
    if (needGroup) {
      this.emitProgress(input.personaId, '私聊语料不足，群里补采风格', 50);
    }
    const groupStyleMessages = needGroup ? await this.collectGroupStyleMessages(input.targetUid) : [];

    // 语音参考兜底（group 模式）：语音不分私聊/群聊、一视同仁——只要还没攒够参考音频就继续补。
    // 先回溯私聊剩余历史（仅在撞 cap、还有更老消息没拉时有意义），仍不够则去好友所在群里补采语音。
    if (mode === 'group' && canTranscribe && voiceClips.length < VOICE_REF_NEED) {
      if (capHit && voiceClips.length < VOICE_REF_NEED) {
        this.emitProgress(input.personaId, '回溯私聊历史语音（克隆参考）', 56);
        await this.salvageVoiceClips(part, selfUin, voiceClips);
      }
      if (voiceClips.length < VOICE_REF_NEED) {
        this.emitProgress(input.personaId, '群聊补充语音（克隆参考）', 58);
        await this.salvageGroupVoiceClips(input.targetUid, voiceClips);
      }
    }

    const sample: AgentLabConversationSample = {
      id: `c2c:${input.targetUid}`,
      title: input.title ?? peerName,
      kind: 'c2c',
      targetId: input.targetUid,
      messages,
    };

    const artifacts = buildPersonaArtifacts({ name: peerName, source: sample, groupStyleMessages });

    // 私聊（+ 群补采）仍太少 → 直接报错，语料不足以克隆。
    if (
      artifacts.stats.friendMessageCount + artifacts.stats.groupStyleMessageCount <
      GROUP_SUPPLEMENT_THRESHOLD
    ) {
      const groupNote =
        artifacts.stats.groupStyleMessageCount > 0
          ? `、群补采 ${artifacts.stats.groupStyleMessageCount} 条`
          : '';
      const modeHint = mode === 'private' ? '（当前为「纯私聊」模式，可改用「配合群聊补充」再试）' : '';
      throw new Error(
        `语料太少，不足以克隆「${peerName}」：私聊有效消息 ${artifacts.stats.friendMessageCount} 条` +
          `${groupNote}，少于 ${GROUP_SUPPLEMENT_THRESHOLD} 条。${modeHint}`,
      );
    }

    // LLM 提炼：覆盖 profile 的 card / deep / fewShots；失败则退回启发式画像，不阻断克隆。
    this.emitProgress(input.personaId, '提炼说话风格与画像', 62);
    let profile: AgentLabPersonaProfile = artifacts.profile;
    let fewShots: Array<{ prompt: string; reply: string }> = [];
    let expressions: AgentLabExpression[] = [];
    if (artifacts.corpusText.trim()) {
      try {
        // card / fewShots / expressions 用「最近优先」的 corpusText 一次性提；
        // deep 用全量历史 map-reduce（分块提取 + 合并），更全且不丢早期信息。
        const [card, shots, exprs, deep] = await Promise.all([
          extractPersonaCard(chatEndpoint, peerName, artifacts.stats, artifacts.corpusText),
          extractFewShots(chatEndpoint, peerName, artifacts.stats, artifacts.corpusText),
          extractExpressions(chatEndpoint, peerName, artifacts.stats, artifacts.corpusText),
          this.extractDeepProfileMapReduce(chatEndpoint, peerName, artifacts.turns, input.personaId),
        ]);
        profile = { ...artifacts.profile, card, deep, extractedByLlm: true };
        fewShots = shots;
        expressions = exprs;
      } catch (error) {
        profile = {
          ...artifacts.profile,
          extractError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    // few-shot 兜底：LLM 没出样本时，从真实问答对里取前几条。
    if (fewShots.length === 0) {
      fewShots = artifacts.pairs.slice(0, 6).map((pair) => ({ prompt: pair.prompt, reply: pair.reply }));
    }

    const pairs: AgentLabStoredPair[] = artifacts.pairs;
    if (pairs.length > 0 && embeddingEndpoint) {
      this.emitProgress(input.personaId, '构建向量索引', 80);
      try {
        const vectors = await embedTexts(
          embeddingEndpoint,
          pairs.map((pair) => `${pair.prompt}\n${pair.reply}`),
        );
        pairs.forEach((pair, index) => {
          pair.embedding = vectors[index];
        });
      } catch {
        // Embedding failures should not block persona creation.
      }
    }

    // 表情包：本地缓存 +（有 vision 模型时）解读内容/场景。无 media/vision 时降级为空。
    if (this.media && stickerAccum.size > 0 && input.models.vision) {
      this.emitProgress(input.personaId, '解读表情包', 88);
    }
    const stickers =
      this.media && stickerAccum.size > 0
        ? await this.buildStickerRefs([...stickerAccum.values()], input.models.vision, peerName, input.personaId)
        : [];

    // 语音画像：使用场景（chat 模型总结）+ 克隆参考音频（按质量挑 Top-K，已排除变声）。
    let voiceProfile: AgentLabVoiceProfile | undefined;
    const voiceWindows = this.collectVoiceWindows(messages, peerName);
    let scenarioSummary = '';
    if (voiceWindows.length > 0) {
      try {
        scenarioSummary = await summarizeVoiceScenario(chatEndpoint, peerName, voiceWindows);
      } catch {
        // 语音场景总结失败不阻断克隆。
      }
    }
    const refClips = selectRefClips(voiceClips);
    const voiceRatio = artifacts.profile.voiceRatio;
    // TA 发过语音（ratio>0）就建画像——即便没转录模型拿不到参考音频，也能用预置音色发语音。
    if (voiceRatio > 0 || scenarioSummary || refClips.length > 0) {
      voiceProfile = {
        ratio: voiceRatio,
        scenarioSummary,
        ...(refClips.length > 0 ? { refClips } : {}),
      };
    }

    const now = Date.now();
    const persona: AgentLabPersona = {
      id: input.personaId,
      ownerId: selfUin,
      name: displayName,
      sourceKind: 'c2c',
      sourceId: input.targetUid,
      sourceTitle: sample.title,
      models: input.models,
      customPrompt: input.customPrompt?.trim() || undefined,
      profile,
      fewShots,
      expressions,
      stickers,
      systemFaces,
      voiceProfile,
      stats: artifacts.stats,
      corpusMessageCount: artifacts.stats.sourceMessageCount,
      pairCount: artifacts.stats.pairCount,
      createdAt: now,
      updatedAt: now,
    };

    this.emitProgress(input.personaId, '保存克隆体', 96);
    this.store.savePersona({ persona, pairs });
    return persona;
  }

  async chat(input: { personaId: string; history: AgentLabChatTurn[]; text: string }) {
    // 运行时对话（意愿闸 / 生成 / 落库 / 记忆反思）已下沉到 AgentRuntime，桌面与 bot 共用同一套。
    return this.runtime.chat(input);
  }

  private c2cPartition(targetUid: string): { sortNo: bigint } | { uid: string } {
    const sortNo = this.session.uidMap.sortNoByUid(targetUid);
    return sortNo !== undefined ? { sortNo } : { uid: targetUid };
  }
}

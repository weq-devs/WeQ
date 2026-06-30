import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import {
  AgentLabStore,
  buildPersonaArtifacts,
  describeSticker,
  distillMemories,
  embedTexts,
  extractExpressions,
  extractFewShots,
  extractPersonaCard,
  extractProfileChunk,
  mergeProfileParts,
  reflectConversation,
  renderProfileChunks,
  runPersonaChat,
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
} from '@weq/agentlab';
import { TtsService, type TtsProviderConfig } from '../common/tts';
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
  /** 合成语音的落盘目录（账号 agentlab 根下，懒建）。 */
  private agentVoiceDir(): string {
    const dir = join(this.rootDir, 'agentvoice');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 按 id 解析某条合成语音的本地路径（供 weq-media://agentvoice 协议读取）。
   * id 必须是安全 basename（仅 hex + .mp3/.wav），防目录逃逸。
   */
  getAgentVoicePath(id: string): string | null {
    if (!/^[0-9a-f]+\.(mp3|wav)$/i.test(id)) return null;
    const path = join(this.agentVoiceDir(), id);
    return existsSync(path) ? path : null;
  }

  /**
   * 这个克隆体当前能不能发语音：开了语音克隆 + 绑了 provider + 该 provider 能力匹配。
   * clone 模式还要求 provider 支持复刻且有参考音频；preset 模式要求 provider 支持固定音色。
   */
  private isVoiceReady(persona: AgentLabPersona): boolean {
    if (!persona.voiceCloneEnabled || !persona.voice || !this.tts) return false;
    const provider = this.tts.getProvider(persona.voice.providerId);
    if (!provider) return false;
    const caps = this.tts.service.capabilities(provider.vendor);
    if (persona.voice.mode === 'clone') {
      return caps.clone && (persona.voiceProfile?.refClips?.length ?? 0) > 0;
    }
    return caps.fixedVoice;
  }

  /**
   * 合成一条语音，写到 agentvoice/<hash>.<ext>，返回文件名（id）。失败返回 null（调用方降级文字）。
   * clone 模式用 TA 的参考音频复刻；preset 模式用预置音色。
   */
  private async synthesizeVoice(persona: AgentLabPersona, text: string): Promise<string | null> {
    const voice = persona.voice;
    if (!this.tts || !voice) return null;
    const provider = this.tts.getProvider(voice.providerId);
    if (!provider) return null;
    try {
      const opts: import('../common/tts').TtsSynthesizeOptions = {};
      if (voice.mode === 'clone') {
        const clips = (persona.voiceProfile?.refClips ?? []).filter((c) => existsSync(c.path));
        if (clips.length === 0) return null;
        opts.refClip = { path: clips[0]!.path, text: clips[0]!.text };
        opts.auxRefClips = clips.slice(1, 3).map((c) => ({ path: c.path, text: c.text }));
      } else {
        opts.voice = voice.voice || provider.voice;
      }
      const { audio, format } = await this.tts.service.synthesize(provider, text, opts);
      const ext = format === 'wav' ? 'wav' : 'mp3';
      const hash = createHash('sha1')
        .update(`${persona.id}|${provider.id}|${voice.mode}|${voice.voice ?? ''}|${text}`)
        .digest('hex')
        .slice(0, 16);
      const id = `${hash}.${ext}`;
      const dest = join(this.agentVoiceDir(), id);
      if (!existsSync(dest)) writeFileSync(dest, audio);
      return id;
    } catch {
      return null;
    }
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
    },
  ): AgentLabPersona | null {
    const record = this.store.getPersona(personaId);
    if (!record) return null;
    const persona = record.persona;
    if (patch.name !== undefined) persona.name = patch.name.trim() || persona.name;
    if (patch.customPrompt !== undefined) persona.customPrompt = patch.customPrompt.trim() || undefined;
    if (patch.voiceCloneEnabled !== undefined) persona.voiceCloneEnabled = patch.voiceCloneEnabled;
    if (patch.voice !== undefined) persona.voice = patch.voice ?? undefined;
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
    const NEED = 5;
    let transcribed = 0;
    let scanned = 0;
    let page = await this.session.c2cMsgs.listLatest(part, PAGE);
    while (
      page.length > 0 &&
      transcribed < VOICE_TRANSCRIBE_CAP &&
      voiceClips.length < NEED &&
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
        if (voiceClips.length >= NEED || transcribed >= VOICE_TRANSCRIBE_CAP) break;
      }
      const oldest = page[page.length - 1];
      if (!oldest) break;
      const next = await this.session.c2cMsgs.listBefore(part, oldest.msgSeq, PAGE);
      if (next.length === 0) break;
      page = next;
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

    // 语音参考兜底：group 模式下，消息撞到上限被截断、且收集到的语料里一条可用语音都没有时，
    // 回溯整段历史只找语音（攒语音克隆参考），不动语料。
    if (mode === 'group' && capHit && canTranscribe && voiceClips.length === 0) {
      this.emitProgress(input.personaId, '回溯历史语音（语音克隆参考）', 58);
      await this.salvageVoiceClips(part, selfUin, voiceClips);
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
    const record = this.store.getPersona(input.personaId);
    if (!record) throw new Error('找不到 persona');
    if (!record.persona.models?.chat) throw new Error('这是旧版克隆体，模型结构已更新，请删除后重建');
    const ctx = { personaId: input.personaId, scope: 'chat' as const };
    const chatEndpoint = this.resolveWithUsage(record.persona.models.chat, 'chat', ctx);
    const embeddingEndpoint = record.persona.models.embedding
      ? this.resolveWithUsage(record.persona.models.embedding, 'embedding', ctx)
      : null;
    const voiceEnabled = this.isVoiceReady(record.persona);
    const result = await runPersonaChat(chatEndpoint, embeddingEndpoint, {
      persona: record.persona,
      pairs: record.pairs,
      history: input.history,
      input: input.text,
      memories: this.memories.get(input.personaId),
      notes: this.notes.get(input.personaId),
      voiceEnabled,
    });
    const now = Date.now();
    // 命中的记忆 +access（越常被想起越不易遗忘）。
    this.memories.touch(input.personaId, result.usedMemoryIds, now);

    // 按 actions 顺序逐条落库（text / 表情 [[sticker:md5]] / 语音 [[voice:id]]）。
    // 语音现合成成音频文件；合成失败则降级为文字，不丢内容。前端按 renderedTurns 逐条揭示。
    const assistantTurns: ConversationTurn[] = [];
    const renderedTurns: string[] = [];
    const pushTurn = (text: string): void => {
      assistantTurns.push({ role: 'assistant', text, ts: now });
      renderedTurns.push(text);
    };
    for (const action of result.actions) {
      if (action.kind === 'text') {
        pushTurn(action.text);
      } else if (action.kind === 'sticker') {
        pushTurn(`[[sticker:${action.sticker.md5}]]`);
      } else {
        const voiceId = await this.synthesizeVoice(record.persona, action.text);
        pushTurn(voiceId ? `[[voice:${voiceId}]]` : action.text);
      }
    }
    // 极端兜底：actions 为空时至少落一条完整文本。
    if (assistantTurns.length === 0) pushTurn(result.text);

    this.conversations.append(input.personaId, [
      { role: 'user', text: input.text, ts: now },
      ...assistantTurns,
    ]);

    // 每隔若干轮，从最近对话蒸馏出克隆体「对对方」的新记忆（不阻塞本次回复）。
    void this.maybeDistillMemories(input.personaId, record.persona.name, chatEndpoint);
    // 每隔若干轮，反思扮演效果：提炼用户纠正 + 对话摘要（不阻塞本次回复）。
    void this.maybeReflect(input.personaId, record.persona.name, chatEndpoint);

    // renderedTurns = 最终落库的有序标记文本，前端据此逐条揭示（含表情图/语音气泡）。
    return { ...result, renderedTurns };
  }

  /** 每 MEMORY_DISTILL_EVERY 个用户回合蒸馏一次记忆；fire-and-forget，失败静默。 */
  private async maybeDistillMemories(
    personaId: string,
    peerName: string,
    chatEndpoint: AgentLabEndpoint,
  ): Promise<void> {
    const MEMORY_DISTILL_EVERY = 6;
    try {
      const conv = this.conversations.get(personaId);
      const userTurns = conv.filter((t) => t.role === 'user').length;
      if (userTurns === 0 || userTurns % MEMORY_DISTILL_EVERY !== 0) return;
      const known = this.memories.get(personaId).map((m) => m.text).slice(-40);
      const fresh = await distillMemories(
        chatEndpoint,
        peerName,
        conv.map((t) => ({ role: t.role, text: t.text })),
        known,
      );
      if (fresh.length > 0) this.memories.add(personaId, fresh, Date.now());
    } catch {
      /* 记忆蒸馏失败不影响聊天 */
    }
  }

  /**
   * 每 REFLECT_EVERY 个用户回合反思一次扮演效果；用 reflectedCount 水位只反思新增片段，
   * 提炼出的 corrections（必须遵守）/ summary（episode）写入 NotesStore。fire-and-forget，失败静默。
   */
  private async maybeReflect(
    personaId: string,
    peerName: string,
    chatEndpoint: AgentLabEndpoint,
  ): Promise<void> {
    const REFLECT_EVERY = 8;
    const MIN_UNREFLECTED = 4;
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

  private c2cPartition(targetUid: string): { sortNo: bigint } | { uid: string } {
    const sortNo = this.session.uidMap.sortNoByUid(targetUid);
    return sortNo !== undefined ? { sortNo } : { uid: targetUid };
  }
}

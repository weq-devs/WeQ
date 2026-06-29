import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import {
  AgentLabStore,
  buildPersonaArtifacts,
  describeSticker,
  distillMemories,
  embedTexts,
  extractDeepProfile,
  extractExpressions,
  extractFewShots,
  extractPersonaCard,
  runPersonaChat,
  summarizeVoiceScenario,
  C2C_SAFETY_CAP,
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
  type AgentLabPersonaProfile,
  type AgentLabStickerRef,
  type AgentLabStoredPair,
  type AgentLabUsage,
  type AgentLabVoiceProfile,
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
}

/** 高频表情包累计：扫描期收集，之后再下载 + vision 解读。 */
interface StickerAccum {
  md5: string;
  fileName: string;
  fileToken: string;
  originalUrl: string;
  ts: number;
  count: number;
}

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

  constructor(
    private readonly session: AccountSession,
    private readonly rootDir: string,
    private readonly resolveEndpoint: EndpointResolver,
    private readonly media?: AgentLabMediaDeps,
    /** 与 AssistantService 共享的 token 记账 / 对话存储（不传则自建，按账号隔离）。 */
    usageStore?: TokenUsageStore,
    conversationStore?: ConversationStore,
  ) {
    super();
    this.store = new AgentLabStore(rootDir);
    this.usage = usageStore ?? new TokenUsageStore(join(rootDir, 'usage.json'));
    this.conversations = conversationStore ?? new ConversationStore(join(rootDir, 'conversations.json'));
    this.memories = new MemoryStore(join(rootDir, 'memories.json'));
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
    return this.store.deletePersona(personaId);
  }

  /** 增量更新克隆体的可编辑字段（额外提示 / 名称 / 语音克隆开关）。 */
  updatePersona(
    personaId: string,
    patch: { name?: string; customPrompt?: string; voiceCloneEnabled?: boolean },
  ): AgentLabPersona | null {
    const record = this.store.getPersona(personaId);
    if (!record) return null;
    const persona = record.persona;
    if (patch.name !== undefined) persona.name = patch.name.trim() || persona.name;
    if (patch.customPrompt !== undefined) persona.customPrompt = patch.customPrompt.trim() || undefined;
    if (patch.voiceCloneEnabled !== undefined) persona.voiceCloneEnabled = patch.voiceCloneEnabled;
    persona.updatedAt = Date.now();
    this.store.savePersona(record);
    return persona;
  }

  // ── Thing 1：语料采集 / 媒体增强 的私有步骤 ─────────────────────────────────

  /** 翻页拉完整私聊（替代"取最近 N 条"），返回 oldest-first，受 cap 限制。 */
  private async collectC2cMessages(part: C2cPartition, cap: number): Promise<C2cMsg[]> {
    const PAGE = 500;
    const out: C2cMsg[] = [];
    let page = await this.session.c2cMsgs.listLatest(part, PAGE); // newest-first
    while (page.length > 0) {
      out.push(...page);
      if (out.length >= cap) break;
      const oldest = page[page.length - 1];
      if (!oldest) break;
      const next = await this.session.c2cMsgs.listBefore(part, oldest.msgSeq, PAGE);
      if (next.length === 0) break;
      page = next;
    }
    return out.slice(0, cap).reverse();
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
        const spoken = await this.transcribePtt(msg.elements, ts);
        if (spoken) {
          text = text.includes('[语音]') ? text.replace('[语音]', `[语音]${spoken}`) : `[语音]${spoken}`;
          transcribed += 1;
        }
      }
      if (!text) continue;
      out.push({ role, text, ts, senderName: role === 'user' ? selfName : peerName, modality });
    }
    return out;
  }

  /** 定位/下载一条语音的 silk → 转录文本（顺手留一份 wav）。失败返回 null。 */
  private async transcribePtt(elements: Element[], tsMs: number): Promise<string | null> {
    const media = this.media;
    if (!media?.transcribe) return null;
    const ptt = elements.find((el): el is Extract<Element, { kind: 'ptt' }> => el.kind === 'ptt');
    if (!ptt) return null;
    let silk = (await media.fileSearch.findFile(tsMs, ptt.fileName, 'ptt')).source;
    if (!silk && ptt.fileToken) {
      silk = await media.mediaDownload.download(ptt.fileToken, {
        ext: '.silk',
        rkeyTypes: [PRIVATE_PTT_RKEY_TYPE, GROUP_PTT_RKEY_TYPE],
      });
    }
    if (!silk) return null;
    // 留一份 wav 供将来语音克隆（best-effort，不阻断转录）。
    if (media.decodeSilkToWavFile) {
      const wav = join(this.voiceDir(), `${ptt.md5 || hashKey(ptt.fileName)}.wav`);
      try {
        if (!existsSync(wav)) await media.decodeSilkToWavFile(silk, wav);
      } catch {
        /* ignore wav 留存失败 */
      }
    }
    try {
      const r = await media.transcribe(silk);
      return r.ok && r.text?.trim() ? r.text.trim() : null;
    } catch {
      return null;
    }
  }

  /** 扫好友（assistant）消息：累计自定义表情包(pic subType===1) + 系统表情 faceText。 */
  private collectStickersAndFaces(
    rawMsgs: C2cMsg[],
    selfUin: string,
  ): { stickers: Map<string, StickerAccum>; faces: Map<string, number> } {
    const stickers = new Map<string, StickerAccum>();
    const faces = new Map<string, number>();
    for (const msg of rawMsgs) {
      if (msg.senderUin.toString() === selfUin) continue; // 只看被克隆者
      const ts = Number(msg.sendTime) * 1000;
      for (const el of msg.elements) {
        if (el.kind === 'pic' && el.subType === 1 && el.md5) {
          const cur = stickers.get(el.md5);
          if (cur) cur.count += 1;
          else
            stickers.set(el.md5, {
              md5: el.md5,
              fileName: el.fileName,
              fileToken: el.fileToken,
              originalUrl: el.originalUrl,
              ts,
              count: 1,
            });
        } else if (el.kind === 'face' && el.faceText) {
          faces.set(el.faceText, (faces.get(el.faceText) ?? 0) + 1);
        }
      }
    }
    return { stickers, faces };
  }

  /** Top 高频表情包 → 本地缓存 + （有 vision 时）解读内容/场景。 */
  private async buildStickerRefs(
    accums: StickerAccum[],
    visionRef: AgentLabModelRef | undefined,
    chatFriendName: string,
    contextHint: string,
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
          const d = await describeSticker(visionEndpoint, chatFriendName, dataUrl, contextHint);
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
      });
    }
    return out;
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

    // 1) 全量私聊（翻页拉完，受安全上限约束）。
    this.emitProgress(input.personaId, '拉取聊天记录', 8);
    const rawMsgs = await this.collectC2cMessages(
      this.c2cPartition(input.targetUid),
      input.limit ?? C2C_SAFETY_CAP,
    );

    // 2) 映射成语料（顺手把语音转录成文本）。
    this.emitProgress(input.personaId, '整理语料 / 转录语音', 28);
    const messages = await this.mapC2cMessages(rawMsgs, selfUin, selfName, peerName);

    // 3) 表情包 + 系统表情白名单（只看好友自己的消息）。
    this.emitProgress(input.personaId, '统计表情', 42);
    const { stickers: stickerAccum, faces } = this.collectStickersAndFaces(rawMsgs, selfUin);
    const systemFaces = [...faces.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, FACE_WHITELIST_CAP)
      .map(([text]) => text);

    // 4) 阈值兜底：私聊有效语料不足 → 去群里补采风格语料。
    const friendMsgCount = messages.filter((m) => m.role === 'assistant' && isMeaningful(m.text)).length;
    if (friendMsgCount < GROUP_SUPPLEMENT_THRESHOLD) {
      this.emitProgress(input.personaId, '私聊语料不足，群里补采风格', 50);
    }
    const groupStyleMessages =
      friendMsgCount < GROUP_SUPPLEMENT_THRESHOLD
        ? await this.collectGroupStyleMessages(input.targetUid)
        : [];

    const sample: AgentLabConversationSample = {
      id: `c2c:${input.targetUid}`,
      title: input.title ?? peerName,
      kind: 'c2c',
      targetId: input.targetUid,
      messages,
    };

    const artifacts = buildPersonaArtifacts({ name: peerName, source: sample, groupStyleMessages });

    // 私聊 + 群补采仍太少 → 直接报错，语料不足以克隆。
    if (
      artifacts.stats.friendMessageCount + artifacts.stats.groupStyleMessageCount <
      GROUP_SUPPLEMENT_THRESHOLD
    ) {
      throw new Error(
        `语料太少，不足以克隆「${peerName}」：私聊有效消息 ${artifacts.stats.friendMessageCount} 条` +
          `${artifacts.stats.groupStyleMessageCount > 0 ? `、群补采 ${artifacts.stats.groupStyleMessageCount} 条` : ''}` +
          `，少于 ${GROUP_SUPPLEMENT_THRESHOLD} 条。`,
      );
    }

    // LLM 提炼：覆盖 profile 的 card / deep / fewShots；失败则退回启发式画像，不阻断克隆。
    this.emitProgress(input.personaId, '提炼说话风格与画像', 62);
    let profile: AgentLabPersonaProfile = artifacts.profile;
    let fewShots: Array<{ prompt: string; reply: string }> = [];
    let expressions: AgentLabExpression[] = [];
    if (artifacts.corpusText.trim()) {
      try {
        const [card, deep, shots, exprs] = await Promise.all([
          extractPersonaCard(chatEndpoint, peerName, artifacts.stats, artifacts.corpusText),
          extractDeepProfile(chatEndpoint, peerName, artifacts.stats, artifacts.corpusText),
          extractFewShots(chatEndpoint, peerName, artifacts.stats, artifacts.corpusText),
          extractExpressions(chatEndpoint, peerName, artifacts.stats, artifacts.corpusText),
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
    const contextHint = artifacts.corpusText.slice(0, 600);
    const stickers =
      this.media && stickerAccum.size > 0
        ? await this.buildStickerRefs([...stickerAccum.values()], input.models.vision, peerName, contextHint, input.personaId)
        : [];

    // 语音使用场景：有转录成功的语音窗口才调 chat 模型总结。
    let voiceProfile: AgentLabVoiceProfile | undefined;
    const voiceWindows = this.collectVoiceWindows(messages, peerName);
    if (voiceWindows.length > 0) {
      try {
        const scenarioSummary = await summarizeVoiceScenario(chatEndpoint, peerName, voiceWindows);
        if (scenarioSummary) voiceProfile = { ratio: artifacts.profile.voiceRatio, scenarioSummary };
      } catch {
        // 语音场景总结失败不阻断克隆。
      }
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
    const result = await runPersonaChat(chatEndpoint, embeddingEndpoint, {
      persona: record.persona,
      pairs: record.pairs,
      history: input.history,
      input: input.text,
      memories: this.memories.get(input.personaId),
    });
    const now = Date.now();
    // 命中的记忆 +access（越常被想起越不易遗忘）。
    this.memories.touch(input.personaId, result.usedMemoryIds, now);
    // 分段连发逐条落库（每条一个 assistant turn），重启/切换后历史仍保持分句。
    const assistantSegments = result.segments.length > 0 ? result.segments : [result.text];
    this.conversations.append(input.personaId, [
      { role: 'user', text: input.text, ts: now },
      ...assistantSegments.map((seg) => ({ role: 'assistant' as const, text: seg, ts: now })),
    ]);

    // 每隔若干轮，从最近对话蒸馏出克隆体「对对方」的新记忆（不阻塞本次回复）。
    void this.maybeDistillMemories(input.personaId, record.persona.name, chatEndpoint);

    return result;
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

  private c2cPartition(targetUid: string): { sortNo: bigint } | { uid: string } {
    const sortNo = this.session.uidMap.sortNoByUid(targetUid);
    return sortNo !== undefined ? { sortNo } : { uid: targetUid };
  }
}

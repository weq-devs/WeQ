// ── Provider / 模型配置（设置里只存 provider；model 在 agent 里选）──────────────

export type AgentLabModelCapability = 'chat' | 'embedding' | 'vision';

export interface AgentLabProviderModel {
  /** 发给 API 的模型 id */
  id: string;
  /** 展示名（可选，默认用 id） */
  label?: string;
  /** 这个模型能干哪些活：聊天 / 向量 / 视觉 */
  capabilities: AgentLabModelCapability[];
}

export interface AgentLabProviderConfig {
  id: string;
  /** 用户可改的显示名 */
  name: string;
  /** 厂商模板 id（catalog.vendor），如 'siliconflow' */
  vendor: string;
  baseUrl: string;
  apiKey: string;
  models: AgentLabProviderModel[];
  createdAt: number;
  updatedAt: number;
}

/** 厂商模板：设置页新建 provider 时一键带入 baseUrl + 推荐模型。 */
export interface AgentLabProviderCatalogEntry {
  vendor: string;
  label: string;
  baseUrl: string;
  apiKeyHint?: string;
  /** 重点推荐（如硅基流动），UI 可高亮 */
  recommended?: boolean;
  models: AgentLabProviderModel[];
}

/** agent 里"某任务用哪个 provider 的哪个 model"。 */
export interface AgentLabModelRef {
  providerId: string;
  model: string;
}

/** 一个克隆体每个任务各自选的模型。 */
export interface AgentLabModels {
  chat: AgentLabModelRef;
  embedding?: AgentLabModelRef;
  vision?: AgentLabModelRef;
  /** 未来：语音克隆（应用层用），这里只存绑定 */
  voiceClone?: AgentLabModelRef;
}

/** 一次 LLM 调用的 token 用量（OpenAI 兼容响应的 usage 字段）。 */
export interface AgentLabUsage {
  model: string;
  kind: 'chat' | 'embedding' | 'vision';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 解析后可直接调用的端点 = provider 的 baseUrl/apiKey + 选定 model。 */
export interface AgentLabEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 这个端点解析时对应的任务类型（用于 token 记账分类）。 */
  kind?: 'chat' | 'embedding' | 'vision';
  /** 每次调用后回调 token 用量（service 注入，写入用量统计）。 */
  onUsage?: (usage: AgentLabUsage) => void;
}

// ── 语料 / 画像 ────────────────────────────────────────────────────────────

export interface AgentLabMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  senderName?: string;
  modality?: 'text' | 'voice';
}

export interface AgentLabConversationSample {
  id: string;
  title: string;
  kind: 'c2c' | 'group';
  targetId: string;
  messages: AgentLabMessage[];
}

/** 一轮发言：同一人在 TURN_GAP 内连发的多条消息合并而成。 */
export interface AgentLabTurn {
  role: 'user' | 'assistant';
  texts: string[];
  startTs: number;
}

/** LLM 提炼的说话风格卡（提炼失败时用启发式统计兜底填充）。 */
export interface AgentLabPersonaCard {
  tone: string;
  personalityTraits: string[];
  catchphrases: string[];
  punctuationStyle: string;
  addressing: string;
  topics: string[];
}

/** LLM 提炼的深层画像（提炼失败时各维度为空）。 */
export interface AgentLabPersonaDeepProfile {
  facts: string[];
  relationship: string;
  reactionPatterns: string[];
  boundaries: string[];
  /** 你们的共同经历大事记（带大致时间），map-reduce 全量历史提炼。 */
  sharedEvents: string[];
}

export interface AgentLabPersonaProfile {
  card: AgentLabPersonaCard;
  deep: AgentLabPersonaDeepProfile;
  styleSummary: string;
  topTerms: string[];
  voiceRatio: number;
  voiceUsageSummary: string;
  relationshipSummary: string;
  extractedByLlm: boolean;
  extractError?: string;
}

/**
 * 高频自定义表情包（pic 元素 elementType=2 且 subType===1，**不是 mface 商城表情**）。
 * 本地缓存 + vision 解读内容 + chat 总结的使用场景。
 */
export interface AgentLabStickerRef {
  /** 表情图 md5（去重键） */
  md5: string;
  /** 元素上的文件名（用于本地寻址 / CDN 补全） */
  fileName: string;
  /** 缓存到 agentlab 目录后的本地路径（找不到/没下到则缺省） */
  localPath?: string;
  /** CDN fileToken，便于将来重新下载 */
  cdnToken: string;
  /** TA 发这张的次数 */
  count: number;
  /** vision 模型解读的表情内容（没配 vision 时为空） */
  description: string;
  /** chat 模型总结的「TA 在什么语境发这张」（没配 vision 时为空） */
  scenario: string;
  /** TA 发这张表情前最近的真实对话短句（≤3 条）：喂给 vision 判断场景 + runtime 选表情。 */
  contexts: string[];
}

/** 一条语音克隆参考音频：本地 wav 路径 + 它的转录文本（复刻需要 prompt_text）+ 时长。 */
export interface AgentLabVoiceRefClip {
  path: string;
  text: string;
  durationMs?: number;
}

/** 语音使用画像：占比 + LLM 总结的「TA 什么场景爱发语音」+ 复刻参考音频（按质量排序）。 */
export interface AgentLabVoiceProfile {
  ratio: number;
  scenarioSummary: string;
  /** 语音克隆参考音频候选，best-first（已排除变声、按 waveform 质量打分）。运行时用第 0 条。 */
  refClips?: AgentLabVoiceRefClip[];
}

/**
 * 克隆体的语音绑定（TTS 不是 LLM，独立于 models）。
 * providerId 指向全局 AppSettings.voiceTranscribe.ttsProviders 里的某个服务商。
 */
export interface AgentLabVoiceBinding {
  providerId: string;
  /** clone = 用 TA 的声音（参考音频复刻，需 provider 支持 + 有 refClips）；preset = 预置音色。 */
  mode: 'clone' | 'preset';
  /** preset 模式的音色 id；clone 模式可留空。 */
  voice?: string;
}

export interface AgentLabPersonaStats {
  sourceMessageCount: number;
  friendMessageCount: number;
  avgFriendMsgChars: number;
  avgFriendBurst: number;
  turnCount: number;
  pairCount: number;
  corpusChars: number;
  /** 群补采的风格语料条数（私聊语料不足时才 > 0）。 */
  groupStyleMessageCount: number;
}

export interface AgentLabFewShotPair {
  prompt: string;
  reply: string;
}

/** 表达风格库的一条：在某情境下 TA 惯用的句式/表达（借鉴 MaiBot expression_learner）。 */
export interface AgentLabExpression {
  /** 情境（≤20 字），如「对某事表示惊叹」。 */
  situation: string;
  /** 对应句式/表达（≤20 字），如「用『我嘞个xxx』」。 */
  style: string;
  /** 在语料里被命中/重复发现的次数（加权选择用）。 */
  count: number;
}

/**
 * 克隆体对「聊天对方（也就是当前用户）」的一条记忆。
 * 视角是「AI 变成 TA」，所以记的是 TA 眼中关于对方的事，配合 access 衰减做遗忘。
 */
export interface AgentLabMemoryItem {
  id: string;
  /** 记住的事实，如「对方最近在准备考研」。 */
  text: string;
  keywords: string[];
  embedding?: number[];
  /**
   * 这条记忆是「关于谁」的（M5 多人）：群聊里克隆体要分别记住「我」和其他克隆体的事。
   * aboutId=成员 id；缺省（旧数据）视为关于私聊对方。召回时按 aboutId 过滤防串人。
   */
  aboutId?: string;
  aboutKind?: AgentLabMemberKind;
  /** 被检索命中的累计次数（越高越不易遗忘）。 */
  accessCount: number;
  createdAt: number;
  lastAccessedAt: number;
}

/**
 * 对话反思笔记（借鉴 CipherTalk 导演笔记）：从「我们和克隆体的对话」里反思出来的，
 * 不是构建产物，runtime 累积，单独存储（service 的 NotesStore）。
 */
export interface AgentLabPersonaNotes {
  /** 用户对扮演的纠正/指示（注入 prompt 必须遵守，如「他从不说谢谢」）。 */
  corrections: string[];
  /** 历次克隆对话的摘要（克隆体自己的 episodic memory，如「上次聊了考研」）。 */
  episodes: string[];
}

/**
 * 发言意愿配置（用户在克隆体设置里调）。作用于意愿闸 scoreReplyGate：
 * - gatePrivate：私聊是否也走意愿闸（默认关——1:1 测试保持必回）；
 * - level：总体发言意愿 0~100（50=中性，越高越爱接话、越低越爱潜水）；
 * - mustReplyOnMention：被 @ 是否必回（默认开）。
 */
export interface AgentLabWillingConfig {
  gatePrivate?: boolean;
  level?: number;
  mustReplyOnMention?: boolean;
}

export interface AgentLabPersona {
  id: string;
  ownerId: string;
  /** 用户起的名字（默认取好友昵称） */
  name: string;
  sourceKind: 'c2c' | 'group';
  sourceId: string;
  sourceTitle: string;
  /** 每个任务选用的 provider+model */
  models: AgentLabModels;
  /** 用户自定义提示，拼进 system prompt */
  customPrompt?: string;
  /** 发言意愿配置（意愿闸调节；缺省=群聊按默认闸、私聊必回）。 */
  willing?: AgentLabWillingConfig;
  /** 是否开启语音克隆（开后运行时允许 bot 自主发语音）。 */
  voiceCloneEnabled?: boolean;
  /** 语音 TTS 绑定（开启语音克隆后用哪个服务商 + 复刻/预置）。 */
  voice?: AgentLabVoiceBinding;
  profile: AgentLabPersonaProfile;
  fewShots: AgentLabFewShotPair[];
  /** 表达风格库：(情境, 句式) 对，runtime 按情境检索后注入 prompt。 */
  expressions: AgentLabExpression[];
  /** 高频自定义表情包（不含 mface 商城表情）。 */
  stickers: AgentLabStickerRef[];
  /** TA 实际用过的系统表情 faceText 白名单（prompt 只许从这里选，防造 /吃饭）。 */
  systemFaces: string[];
  /** 语音使用画像（没语音/没转录时缺省）。 */
  voiceProfile?: AgentLabVoiceProfile;
  stats: AgentLabPersonaStats;
  corpusMessageCount: number;
  pairCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentLabStoredPair {
  id: string;
  prompt: string;
  reply: string;
  replies: string[];
  keywords: string[];
  embedding?: number[];
}

export interface AgentLabChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AgentLabChatRequest {
  persona: AgentLabPersona;
  pairs: AgentLabStoredPair[];
  history: AgentLabChatTurn[];
  input: string;
  /** 克隆体对当前对方的记忆（service 注入；命中的会在结果里回报以便记账衰减）。 */
  memories?: AgentLabMemoryItem[];
  /** 对话反思笔记（service 注入）：用户纠正 + 历次对话摘要。 */
  notes?: AgentLabPersonaNotes;
  /** 关闭/调节错别字强度（默认开，约 0.18）。 */
  typoIntensity?: number;
  /** 是否允许 bot 自主发语音（克隆体开了语音克隆 + 配了 TTS 时由 service 置 true）。 */
  voiceEnabled?: boolean;
  /**
   * 「此刻对当前说话人的感觉」语气指令（群聊 M4 注入，由 describeRelationTone 生成）。
   * 让克隆体语气随关系好感/情绪变化。私聊路径一般不传。
   */
  relationNote?: string;
}

/**
 * 克隆体一轮回复里的一个有序动作（借鉴 MaiBot 的 action 模型）。
 * - text：一条文字消息（已分条 + 错别字后处理）。
 * - sticker：一张「模型看着真实清单按编号选定」的自定义表情。
 * - voice：一条语音消息（仅文本；真正合成在 service 层做，pure 包不碰 TTS/参考音频）。
 */
export type AgentLabChatAction =
  | { kind: 'text'; text: string }
  | { kind: 'sticker'; sticker: AgentLabStickerRef }
  | { kind: 'voice'; text: string };

export interface AgentLabChatResult {
  /** 完整回复文本（分条用 \n 连接，落库/few-shot 用）。 */
  text: string;
  /** 分条后的纯文字消息（不含表情/语音；few-shot/兜底用）。 */
  segments: string[];
  /** 有序动作列表（text/sticker/voice）：service 据此按序落库、前端按序揭示。 */
  actions: AgentLabChatAction[];
  promptPreview: string;
  matches: AgentLabStoredPair[];
  /** 本轮检索命中、需要 +access 的记忆 id。 */
  usedMemoryIds: string[];
  /** 回复意愿 0~1（越低越敷衍/越慢）。 */
  willingness: number;
  /** 建议的首条回复前延迟（ms，前端模拟「在打字」）。 */
  replyDelayMs: number;
  /** 第一张选中的自定义表情（兼容旧读取方；完整顺序见 actions）。 */
  sticker?: AgentLabStickerRef | null;
}

// ──────────────────────────────────────────────────────────────────────────
// 群聊（多克隆体）——M1 数据底座
//
// 视角升级：私聊是「一个克隆体 ↔ 我」的单线；群聊是「多个克隆体 + 我」同处一室，
// 克隆体之间也会你来我往。这里只定义**领域类型 + 存储 port 接口**（存储无关），
// JSON / SQLite 两种后端都实现同一组 port，引擎只依赖接口、不认识具体存储。
// ──────────────────────────────────────────────────────────────────────────

/** 群成员种类：'user' = 账号主人（我），'persona' = 某个克隆体。 */
export type AgentLabMemberKind = 'user' | 'persona';

/** 一个克隆体群聊。 */
export interface AgentLabGroup {
  id: string;
  name: string;
  /** 归属账号 uin（和 persona.ownerId 一致，账号隔离）。 */
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 群成员。memberId 语义按 kind 区分：
 * - persona：memberId = personaId；
 * - user：memberId = 账号 uin（便于将来 napcat 导出时对齐真实 QQ 号）。
 */
export interface AgentLabGroupMember {
  groupId: string;
  memberId: string;
  kind: AgentLabMemberKind;
  /** 群内显示名（克隆体名 / 「我」）。 */
  displayName: string;
  joinedAt: number;
}

/**
 * 一条群消息（替代私聊的 ConversationTurn；带发送者身份 + @ + 引用）。
 * text 沿用私聊的标记文本约定（[[sticker:md5]] / [[voice:id]] / 纯文本），
 * 前端复用同一套四叉渲染，只是按 senderId 分气泡。
 */
export interface AgentLabGroupMessage {
  id: string;
  groupId: string;
  /** 发送者 memberId（persona 的 personaId 或 user 的 uin）。 */
  senderId: string;
  senderKind: AgentLabMemberKind;
  /** 标记文本（落库/few-shot 用）。 */
  text: string;
  /** 原始有序动作（可选，富渲染/调试用；纯文本消息可省）。 */
  actions?: AgentLabChatAction[];
  ts: number;
  /** 回复的目标消息 id（可选）。 */
  replyToId?: string;
  /** @ 到的成员 memberId 列表（驱动 @必回）。 */
  mentions?: string[];
}

/**
 * 关系态（克隆体「主观」看某个人）。M4 才真正随互动更新并反哺意愿/语气，
 * M1 先把类型和存储 port 落地，初值给中性基线。
 */
export interface AgentLabRelation {
  /** 谁的视角（克隆体）。 */
  subjectPersonaId: string;
  /** 对谁（另一个成员）。 */
  objectId: string;
  objectKind: AgentLabMemberKind;
  /** 好感度 0~100。 */
  affinity: number;
  /** 熟悉度 0~100（随互动次数缓慢增长）。 */
  familiarity: number;
  /** 最近情绪 -50~+50（对这个人当前的情绪，随时间回落到 0）。 */
  mood: number;
  /** 累计互动次数。 */
  interactionCount: number;
  lastInteractAt: number;
  updatedAt: number;
}

/**
 * 群/成员/群消息的存储 port（JSON 与 SQLite 后端共同实现）。
 * 同步接口——JSON 是同步落盘、better-sqlite3 也是同步 API，二者天然对齐。
 */
export interface AgentLabGroupStore {
  createGroup(input: { id: string; name: string; ownerId: string; now: number }): AgentLabGroup;
  listGroups(ownerId: string): AgentLabGroup[];
  getGroup(id: string): AgentLabGroup | null;
  renameGroup(id: string, name: string, now: number): void;
  deleteGroup(id: string): void;

  setMembers(groupId: string, members: AgentLabGroupMember[]): void;
  listMembers(groupId: string): AgentLabGroupMember[];
  addMember(member: AgentLabGroupMember): void;
  removeMember(groupId: string, memberId: string): void;

  appendMessage(message: AgentLabGroupMessage): void;
  /** 取最近 limit 条（时间正序返回；省略 limit 取全部）。 */
  listMessages(groupId: string, limit?: number): AgentLabGroupMessage[];
  clearMessages(groupId: string): void;
}

/** 关系态的存储 port（JSON 与 SQLite 后端共同实现）。 */
export interface AgentLabRelationStore {
  get(subjectPersonaId: string, objectId: string): AgentLabRelation | null;
  listForSubject(subjectPersonaId: string): AgentLabRelation[];
  upsert(relation: AgentLabRelation): void;
  /**
   * 按增量更新（不存在则以 base 初值创建），返回更新后的关系态。
   * clamp 到各自区间；M4 的互动打分会调这个。
   */
  applyDelta(
    subjectPersonaId: string,
    objectId: string,
    objectKind: AgentLabMemberKind,
    delta: { affinity?: number; familiarity?: number; mood?: number },
    now: number,
  ): AgentLabRelation;
}

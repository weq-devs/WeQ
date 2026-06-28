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

/** 解析后可直接调用的端点 = provider 的 baseUrl/apiKey + 选定 model。 */
export interface AgentLabEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
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
}

/** 语音使用画像：占比 + LLM 总结的「TA 什么场景爱发语音」。 */
export interface AgentLabVoiceProfile {
  ratio: number;
  scenarioSummary: string;
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
  profile: AgentLabPersonaProfile;
  fewShots: AgentLabFewShotPair[];
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
}

export interface AgentLabChatResult {
  text: string;
  promptPreview: string;
  matches: AgentLabStoredPair[];
}

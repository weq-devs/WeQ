import type {
  AgentLabConversationSample,
  AgentLabMessage,
  AgentLabPersonaProfile,
  AgentLabPersonaStats,
  AgentLabStoredPair,
  AgentLabTurn,
} from './types';

/** 同一人相邻消息间隔超过此值（秒）视为新一轮 */
export const TURN_GAP_SECONDS = 3 * 60;
/** 单条消息进语料的字符上限（防超长消息撑爆） */
export const MSG_CHAR_CAP = 200;
/** 渲染给 LLM 的语料总字符预算（最近的轮次优先） */
export const CORPUS_CHAR_BUDGET = 14000;
/** 群补采风格语料的渲染字符预算（接在私聊语料后面） */
export const GROUP_STYLE_CHAR_BUDGET = 4000;
/** 一轮内连发多条的分隔符（提示词里会说明） */
export const BURST_JOINER = '／';

/** 深层画像 map-reduce：单块字符上限（一块喂一次 LLM 提取部分画像） */
export const PROFILE_CHUNK_CHARS = 10000;
/** 深层画像 map-reduce：最多切几块（超出保留最近的，近况优先，控制成本） */
export const PROFILE_MAX_CHUNKS = 12;

// ── Thing 1 蒸馏管线的上限常量（service 层 buildFromC2c 取用，集中在此便于调参）──

/** 私聊翻页安全上限（防极端会话撑爆内存） */
export const C2C_SAFETY_CAP = 20000;
/** 默认总语料消息上限（替代旧的克隆程度 high/low；私聊翻页装满即停，控制时间/成本） */
export const C2C_CORPUS_CAP = 6000;
/** 对方有效消息 < 此值 → 去群里补采风格语料；私聊+群仍 < 此值 → 提示失败 */
export const GROUP_SUPPLEMENT_THRESHOLD = 50;
/** 群补采最多扫几个群 */
export const GROUP_MAX = 8;
/** 每个群最多取多少条该好友的发言 */
export const PER_GROUP_MSG_CAP = 300;
/** 每个群最多翻多少条消息去找该好友（防大群空翻） */
export const PER_GROUP_SCAN_CAP = 3000;
/** 群补采总语料上限 */
export const GROUP_TOTAL_CAP = 800;
/** 单次克隆最多转录多少条语音 */
export const VOICE_TRANSCRIBE_CAP = 150;
/** 取前几个高频表情包做 vision 解读 */
export const STICKER_CAP = 6;
/** 系统表情白名单保留几个 */
export const FACE_WHITELIST_CAP = 15;
/** 问答对单边文本上限 / 连发条数上限 */
const PAIR_TEXT_CAP = 160;
const PAIR_MAX_REPLIES = 6;
/** 至多保留的问答对数量 */
const MAX_PAIRS = 400;

/** 纯占位符（无真实文本内容）的消息，进语料只会变噪声。 */
const PLACEHOLDER_ONLY = /^(\s*(\[图片\]|\[视频\]|\[语音\]|\[回复\]|\[文件\]|\[动画表情\]))+\s*$/;

function isMeaningfulText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !PLACEHOLDER_ONLY.test(trimmed);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9一-龥]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function topTerms(turns: AgentLabTurn[], role: 'assistant', limit: number): string[] {
  const counts = new Map<string, number>();
  for (const turn of turns) {
    if (turn.role !== role) continue;
    for (const text of turn.texts) {
      for (const word of tokenize(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

/**
 * 轮次合并：同一人、间隔 ≤ TURN_GAP_SECONDS 的连发消息归为一轮。
 * 微信/QQ 对话不是严格一问一答，不合并的话统计失真、问答对全错位。
 * 入参要求按时间正序（oldest-first）。
 */
export function mergeTurns(messages: AgentLabMessage[]): AgentLabTurn[] {
  const turns: AgentLabTurn[] = [];
  let prevTs = 0;
  for (const msg of messages) {
    if (!isMeaningfulText(msg.text)) {
      prevTs = msg.ts;
      continue;
    }
    const text = msg.text.trim().slice(0, MSG_CHAR_CAP);
    const tsSec = Math.floor(msg.ts / 1000);
    const prevSec = Math.floor(prevTs / 1000);
    const last = turns[turns.length - 1];
    if (last && last.role === msg.role && tsSec - prevSec <= TURN_GAP_SECONDS) {
      last.texts.push(text);
    } else {
      turns.push({ role: msg.role, texts: [text], startTs: msg.ts });
    }
    prevTs = msg.ts;
  }
  return turns;
}

function computeVoiceUsage(messages: AgentLabMessage[]): {
  voiceRatio: number;
  voiceUsageSummary: string;
} {
  let voice = 0;
  let convo = 0;
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue; // 只看被克隆者
    convo += 1;
    if (msg.modality === 'voice') voice += 1;
  }
  if (convo === 0) {
    return { voiceRatio: 0, voiceUsageSummary: '语料不足，暂时无法判断语音使用习惯' };
  }
  const voiceRatio = Number((voice / convo).toFixed(4));
  if (voiceRatio >= 0.35) {
    return { voiceRatio, voiceUsageSummary: '语音使用频率较高，聊天中经常直接发语音' };
  }
  if (voiceRatio >= 0.12) {
    return { voiceRatio, voiceUsageSummary: '语音和文字混合使用，部分场景会切换为语音' };
  }
  return { voiceRatio, voiceUsageSummary: '以文字回复为主，语音使用频率较低' };
}

export function computeStats(
  _messages: AgentLabMessage[],
  turns: AgentLabTurn[],
  pairCount: number,
  corpusChars: number,
  groupStyleMessageCount = 0,
): AgentLabPersonaStats {
  let friendMsgs = 0;
  let friendChars = 0;
  let friendTurns = 0;
  let total = 0;
  for (const turn of turns) {
    total += turn.texts.length;
    if (turn.role !== 'assistant') continue;
    friendTurns += 1;
    friendMsgs += turn.texts.length;
    for (const t of turn.texts) friendChars += t.length;
  }
  return {
    sourceMessageCount: total,
    friendMessageCount: friendMsgs,
    avgFriendMsgChars: friendMsgs > 0 ? Math.round(friendChars / friendMsgs) : 0,
    avgFriendBurst: friendTurns > 0 ? Math.round((friendMsgs / friendTurns) * 10) / 10 : 0,
    turnCount: turns.length,
    pairCount,
    corpusChars,
    groupStyleMessageCount,
  };
}

/** 把轮次渲染成「我: xxx／xxx」式对话文本：从最新往回装，装满预算后按时间正序输出。 */
export function renderCorpus(turns: AgentLabTurn[], friendName: string): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn) continue;
    const speaker = turn.role === 'assistant' ? friendName : '我';
    const line = `${speaker}: ${turn.texts.join(BURST_JOINER)}`;
    if (used + line.length > CORPUS_CHAR_BUDGET && lines.length > 0) break;
    lines.push(line);
    used += line.length;
  }
  return lines.reverse().join('\n');
}

/**
 * 深层画像语料：把全部轮次按时间正序切成 ≤PROFILE_CHUNK_CHARS 的块（map-reduce 的 map 输入）。
 * 与 renderCorpus 不同——这里要全量历史而非最近优先；超过 PROFILE_MAX_CHUNKS 时保留最近的块
 * （近期生活状态比远古历史更重要）。
 */
export function renderProfileChunks(turns: AgentLabTurn[], friendName: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let chars = 0;
  for (const turn of turns) {
    const speaker = turn.role === 'assistant' ? friendName : '我';
    const line = `${speaker}: ${turn.texts.join(BURST_JOINER)}`;
    if (chars + line.length > PROFILE_CHUNK_CHARS && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
      chars = 0;
    }
    current.push(line);
    chars += line.length;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks.slice(-PROFILE_MAX_CHUNKS);
}

/**
 * 渲染群补采的风格语料：只有 TA 自己在群里的发言（一行一条），无对话上下文。
 * 仅供画像/风格提炼「学语气」，不构成问答对。装满预算即停。
 */
export function renderGroupStyleCorpus(messages: AgentLabMessage[], friendName: string): string {
  const lines: string[] = [];
  let used = 0;
  for (const msg of messages) {
    if (!isMeaningfulText(msg.text)) continue;
    const line = `${friendName}: ${msg.text.trim().slice(0, MSG_CHAR_CAP)}`;
    if (used + line.length > GROUP_STYLE_CHAR_BUDGET && lines.length > 0) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

/** 抽取「我的一轮 → TA 的下一轮」真实问答对（检索式 few-shot 的索引单元）。 */
export function extractPairs(turns: AgentLabTurn[]): AgentLabStoredPair[] {
  const out: AgentLabStoredPair[] = [];
  for (let i = 1; i < turns.length; i += 1) {
    const ask = turns[i - 1];
    const reply = turns[i];
    if (!ask || !reply) continue;
    if (ask.role !== 'user' || reply.role !== 'assistant') continue;
    const prompt = ask.texts.join(BURST_JOINER).slice(0, PAIR_TEXT_CAP);
    const replies = reply.texts.slice(0, PAIR_MAX_REPLIES).map((t) => t.slice(0, PAIR_TEXT_CAP));
    if (prompt.length < 2 || replies.length === 0) continue;
    const joined = replies.join('\n');
    out.push({
      id: `pair-${i}`,
      prompt,
      reply: joined,
      replies,
      keywords: Array.from(new Set([...tokenize(prompt), ...tokenize(joined)])).slice(0, 24),
    });
  }
  return out.slice(-MAX_PAIRS);
}

function summarizeStyle(turns: AgentLabTurn[], stats: AgentLabPersonaStats): string {
  if (stats.friendMessageCount === 0) return '语料不足';
  const hints: string[] = [];
  hints.push(stats.avgFriendMsgChars <= 12 ? '偏短句' : stats.avgFriendMsgChars <= 24 ? '中短句' : '偏长句');
  if (stats.avgFriendBurst >= 2) hints.push('习惯连发短消息');
  const friendTexts = turns.filter((t) => t.role === 'assistant').flatMap((t) => t.texts);
  const exclamation = friendTexts.filter((t) => /[!！]/.test(t)).length;
  const emoji = friendTexts.filter((t) => /\[[^\]]+\]|[\u{1F300}-\u{1FAFF}☀-➿]/u.test(t)).length;
  if (friendTexts.length > 0 && exclamation / friendTexts.length >= 0.2) hints.push('语气更活');
  if (friendTexts.length > 0 && emoji / friendTexts.length >= 0.15) hints.push('常带表情或情绪标记');
  return hints.join('，');
}

/**
 * 启发式画像（纯统计，不调 LLM）。LLM 提炼成功时只用其 voiceUsage / styleSummary / topTerms 部分，
 * card / deep 由 LLM 覆盖；提炼失败时用这里的统计兜底填 card。
 */
export function buildHeuristicProfile(
  messages: AgentLabMessage[],
  turns: AgentLabTurn[],
  stats: AgentLabPersonaStats,
  name: string,
  sourceTitle: string,
  groupStyleMessages: AgentLabMessage[] = [],
): AgentLabPersonaProfile {
  const voiceUsage = computeVoiceUsage(messages);
  // 群补采的风格语料也算 TA 的词频，合成一个 assistant-only 轮次喂进 topTerms。
  const termTurns: AgentLabTurn[] =
    groupStyleMessages.length > 0
      ? [...turns, { role: 'assistant', texts: groupStyleMessages.map((m) => m.text), startTs: 0 }]
      : turns;
  const terms = topTerms(termTurns, 'assistant', 12);
  const styleSummary = summarizeStyle(turns, stats);
  return {
    card: {
      tone: styleSummary,
      personalityTraits: [],
      catchphrases: [],
      punctuationStyle: '',
      addressing: '',
      topics: terms.slice(0, 10),
    },
    deep: { facts: [], relationship: '', reactionPatterns: [], boundaries: [], sharedEvents: [] },
    styleSummary,
    topTerms: terms,
    voiceRatio: voiceUsage.voiceRatio,
    voiceUsageSummary: voiceUsage.voiceUsageSummary,
    relationshipSummary: `语料来自 ${sourceTitle}，当前克隆对象为 ${name}。`,
    extractedByLlm: false,
  };
}

export interface AgentLabBuildArtifacts {
  turns: AgentLabTurn[];
  pairs: AgentLabStoredPair[];
  stats: AgentLabPersonaStats;
  corpusText: string;
  profile: AgentLabPersonaProfile;
}

/**
 * 纯计算阶段：把会话语料处理成轮次 / 问答对 / 统计 / 渲染语料 / 启发式画像。
 * LLM 提炼在 service 层异步进行，再覆盖 profile 的 card / deep。
 */
export function buildPersonaArtifacts(input: {
  name: string;
  source: AgentLabConversationSample;
  /** 群补采的风格语料（assistant-only）。私聊语料不足时才有；只学风格、不进问答对。 */
  groupStyleMessages?: AgentLabMessage[];
}): AgentLabBuildArtifacts {
  const groupStyleMessages = input.groupStyleMessages ?? [];
  const turns = mergeTurns(input.source.messages);
  const pairs = extractPairs(turns);
  const c2cCorpus = renderCorpus(turns, input.name);
  const corpusText =
    groupStyleMessages.length > 0
      ? `${c2cCorpus}\n\n【${input.name} 在群里的发言（只学风格语气，别学具体内容，这些不是对你说的）】\n${renderGroupStyleCorpus(
          groupStyleMessages,
          input.name,
        )}`
      : c2cCorpus;
  const stats = computeStats(
    input.source.messages,
    turns,
    pairs.length,
    corpusText.length,
    groupStyleMessages.length,
  );
  const profile = buildHeuristicProfile(
    input.source.messages,
    turns,
    stats,
    input.name,
    input.source.title,
    groupStyleMessages,
  );
  return { turns, pairs, stats, corpusText, profile };
}

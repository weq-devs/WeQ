/**
 * 画像提炼的 LLM 调用（OpenAI 兼容 /chat/completions，纯 fetch，无 SDK）。
 *
 * 不用结构化输出：deepseek / 智谱 / ollama 等常把 JSON 包进 ```json 围栏或带前后缀，
 * 严格解析会失败。改为「让模型只输出 JSON + 宽松抠出 JSON + 失败重试一次」。
 */
import type {
  AgentLabPersonaCard,
  AgentLabPersonaDeepProfile,
  AgentLabPersonaStats,
  AgentLabEndpoint,
  AgentLabExpression,
  AgentLabFewShotPair,
} from './types';
import { reportUsage } from './http';

function coerceString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(coerceString).filter(Boolean);
  }
  const single = coerceString(value);
  return single ? [single] : [];
}

/** 从模型输出里宽松抠出 JSON：剥 ``` 围栏，再取首个 { 到末个 } 之间。 */
function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

async function chatCompletion(
  endpoint: AgentLabEndpoint,
  system: string,
  prompt: string,
  temperature: number,
): Promise<string> {
  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify({
      model: endpoint.model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`AgentLab 提炼接口调用失败: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  reportUsage(endpoint, data);
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * OpenAI 兼容的多模态调用：把一张图（data URL）+ 文本一起发给 vision 模型。
 * 用于表情包解读。
 */
async function visionCompletion(
  endpoint: AgentLabEndpoint,
  system: string,
  text: string,
  imageDataUrl: string,
  temperature: number,
): Promise<string> {
  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify({
      model: endpoint.model,
      temperature,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`AgentLab 视觉接口调用失败: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  reportUsage(endpoint, data);
  return data.choices?.[0]?.message?.content ?? '';
}

/** generateText + 宽松解析 + 失败重试一次。 */
async function generateJson(
  endpoint: AgentLabEndpoint,
  system: string,
  prompt: string,
  temperature: number,
  label: string,
): Promise<Record<string, unknown>> {
  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const userPrompt =
      attempt === 0
        ? prompt
        : `${prompt}\n\n注意：上一次输出无法解析为 JSON，请严格只输出一个合法 JSON 对象，不要任何解释、前后缀或代码围栏。`;
    lastRaw = await chatCompletion(endpoint, system, userPrompt, temperature);
    try {
      const parsed = extractJson(lastRaw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* 重试一次 */
    }
  }
  throw new Error(`${label}解析失败，模型输出不是合法 JSON：${lastRaw.slice(0, 200)}`);
}

const CARD_JSON_SHAPE = `{
  "tone": "语气与说话风格，2-4 句中文描述",
  "personalityTraits": ["性格特征短语", "..."],
  "catchphrases": ["口头禅/高频用语/常用语气词，尽量列全，最多 20 个，没有就给空数组"],
  "punctuationStyle": "标点与排版习惯，如：几乎不用句号、爱用~和省略号、习惯连发短句",
  "addressing": "对聊天对象（语料中的'我'）的称呼习惯，没有特别称呼就写'无特别称呼'",
  "topics": ["常聊话题", "..."]
}`;

const PROFILE_JSON_SHAPE = `{
  "facts": ["TA 的工作/家庭/生活事实，一条一项，具体（如'在杭州做后端开发''养了只叫咪咪的猫'）"],
  "relationship": "你们关系的定位与相处模式，1-3 句（如'大学室友，互损但有事真上'）",
  "reactionPatterns": ["「情境 → 典型反应」规则（如'对方抱怨工作时，先调侃两句再认真安慰'）"],
  "boundaries": ["TA 的立场/雷点/回避的话题/明显不了解的领域"]
}`;

const FEWSHOT_JSON_SHAPE = `{
  "examples": [
    { "user": "'我'说的内容（一轮内多条可合并成一句）", "replies": ["对方的回复，连发的逐条一项，必须摘自原文"] }
  ]
}`;

function corpusPreamble(friendName: string, stats: AgentLabPersonaStats, corpusText: string): string {
  return [
    `下面是「我」和「${friendName}」的聊天记录（按时间正序，一行一轮；同一人连发多条时用「／」分隔）。`,
    `已知统计：${friendName} 共 ${stats.friendMessageCount} 条消息，单条平均 ${stats.avgFriendMsgChars} 字，平均一轮连发 ${stats.avgFriendBurst} 条。`,
    '',
    corpusText,
  ].join('\n');
}

export async function extractPersonaCard(
  endpoint: AgentLabEndpoint,
  friendName: string,
  stats: AgentLabPersonaStats,
  corpusText: string,
): Promise<AgentLabPersonaCard> {
  const raw = await generateJson(
    endpoint,
    '你是一名语言风格侧写师。根据聊天记录总结目标人物的说话风格与性格，' +
      '只依据记录本身，不要臆造；描述要具体可执行（能直接指导模仿其说话），避免空泛形容词。' +
      '注意：QQ 系统表情（如 /捂脸 /旺柴）是固定集合，会另行统计提供清单——' +
      '不要把风格泛化成「爱用斜杠加动作」，更不要臆造没出现过的 /动作。' +
      `\n只输出一个 JSON 对象，不要任何解释或代码围栏，格式如下：\n${CARD_JSON_SHAPE}`,
    `${corpusPreamble(friendName, stats, corpusText)}\n\n请侧写「${friendName}」，按要求输出 JSON。`,
    0.3,
    '画像卡',
  );
  return {
    tone: coerceString(raw.tone),
    personalityTraits: coerceStringArray(raw.personalityTraits),
    catchphrases: coerceStringArray(raw.catchphrases).slice(0, 20),
    punctuationStyle: coerceString(raw.punctuationStyle),
    addressing: coerceString(raw.addressing),
    topics: coerceStringArray(raw.topics),
  };
}

export async function extractDeepProfile(
  endpoint: AgentLabEndpoint,
  friendName: string,
  stats: AgentLabPersonaStats,
  corpusText: string,
): Promise<AgentLabPersonaDeepProfile> {
  const raw = await generateJson(
    endpoint,
    `你是人物侧写师。从「我」和「${friendName}」的聊天记录里提取关于「${friendName}」的深层信息：` +
      '生活事实、你们的关系、TA 在不同情境下的典型反应、立场与边界。' +
      '只依据记录本身，不要臆造；没有依据的维度给空数组/空字符串。' +
      `\n只输出一个 JSON 对象，不要任何解释或代码围栏，格式如下：\n${PROFILE_JSON_SHAPE}`,
    `${corpusPreamble(friendName, stats, corpusText)}\n\n请提炼「${friendName}」的深层画像，按要求输出 JSON。`,
    0.2,
    '深层画像',
  );
  return {
    facts: coerceStringArray(raw.facts).slice(0, 15),
    relationship: coerceString(raw.relationship),
    reactionPatterns: coerceStringArray(raw.reactionPatterns).slice(0, 10),
    boundaries: coerceStringArray(raw.boundaries).slice(0, 8),
  };
}

export async function extractFewShots(
  endpoint: AgentLabEndpoint,
  friendName: string,
  stats: AgentLabPersonaStats,
  corpusText: string,
): Promise<AgentLabFewShotPair[]> {
  const raw = await generateJson(
    endpoint,
    '你是对话样本挖掘器。从聊天记录中挑选最能体现目标人物说话风格的真实问答对：' +
      '「我」说了什么、对方怎么回的。必须原样摘抄原文（可去掉无关上下文），不许改写、不许编造。' +
      '优先挑风格鲜明（口头禅、玩笑、典型语气）且不含隐私敏感内容（金额、地址、证件号）的样本。' +
      `\n只输出一个 JSON 对象，不要任何解释或代码围栏，格式如下：\n${FEWSHOT_JSON_SHAPE}`,
    `${corpusPreamble(friendName, stats, corpusText)}\n\n请从中挑选 5-8 组「我 → ${friendName}」的代表性问答对，按要求输出 JSON。`,
    0.2,
    '对话样本',
  );
  const examples = Array.isArray(raw.examples) ? raw.examples : [];
  const out: AgentLabFewShotPair[] = [];
  for (const item of examples) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const prompt = coerceString(row.user);
    const replies = coerceStringArray(row.replies);
    if (!prompt || replies.length === 0) continue;
    out.push({ prompt, reply: replies.join('\n') });
  }
  return out.slice(0, 10);
}

const EXPRESSION_JSON_SHAPE = `{
  "expressions": [
    { "situation": "情境，≤20字（如：对意外的事表示惊叹）", "style": "对应句式/表达，≤20字（如：用『我嘞个xxx』）" }
  ]
}`;

/**
 * 表达风格库提取（借鉴 MaiBot expression_learner）：从语料里挖 TA 的 (情境 → 句式) 习惯。
 * 学的是「在什么场景下惯用什么说法」，比口头禅更细。失败返回空数组、不阻断克隆。
 */
export async function extractExpressions(
  endpoint: AgentLabEndpoint,
  friendName: string,
  stats: AgentLabPersonaStats,
  corpusText: string,
): Promise<AgentLabExpression[]> {
  let raw: Record<string, unknown>;
  try {
    raw = await generateJson(
      endpoint,
      '你是表达风格分析器。从聊天记录里总结目标人物「在什么情境下惯用什么句式/表达」。' +
        '只看文字、忽略图片表情；只学目标人物本人的说法，不要学「我」的。' +
        '要可泛化、能迁移到新对话——不要带具体人名地名事件，聚焦句式、口癖、梗、语气结构。' +
        '每条形如「当(情境)时，用(句式)」，情境和句式都控制在 20 字内。挑 8-15 条最鲜明的。' +
        `\n只输出一个 JSON 对象，不要任何解释或代码围栏，格式如下：\n${EXPRESSION_JSON_SHAPE}`,
      `${corpusPreamble(friendName, stats, corpusText)}\n\n请提炼「${friendName}」的表达习惯，按要求输出 JSON。`,
      0.3,
      '表达风格库',
    );
  } catch {
    return [];
  }
  const list = Array.isArray(raw.expressions) ? raw.expressions : [];
  const out: AgentLabExpression[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const situation = coerceString(row.situation).slice(0, 30);
    const style = coerceString(row.style).slice(0, 30);
    if (!situation || !style) continue;
    const key = `${situation}|${style}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ situation, style, count: 1 });
  }
  return out.slice(0, 15);
}

const MEMORY_JSON_SHAPE = `{
  "memories": ["关于对方的一条新信息，具体一句话（如：对方最近在准备考研；对方养了只布偶猫）"]
}`;

/**
 * 从「我们和克隆体的最近对话」里蒸馏出克隆体「对对方（用户）」该记住的新事实。
 * 视角：你就是被克隆的人，从下面对话里记住关于「对方」的、值得长期记得的信息。
 * 返回 0~5 条短句；失败/没有则空数组。
 */
export async function distillMemories(
  endpoint: AgentLabEndpoint,
  friendName: string,
  conversation: Array<{ role: 'user' | 'assistant'; text: string }>,
  known: string[],
): Promise<string[]> {
  const lines = conversation
    .filter((t) => t.text.trim())
    .slice(-24)
    .map((t) => `${t.role === 'user' ? '对方' : '你'}：${t.text}`)
    .join('\n');
  if (!lines.trim()) return [];
  const knownBlock = known.length > 0 ? `\n\n你已经记住的（不要重复）：\n${known.map((k) => `- ${k}`).join('\n')}` : '';
  let raw: Record<string, unknown>;
  try {
    raw = await generateJson(
      endpoint,
      `你是「${friendName}」，正在回看自己和「对方」最近的聊天。` +
        '提炼出关于「对方」值得你长期记住的新信息（TA 的近况、喜好、计划、和你的约定、对你的态度等）。' +
        '只记真正有信息量、能在以后聊天用到的；客套话、一次性闲聊不要记。没有就给空数组。' +
        `\n只输出一个 JSON 对象，不要任何解释或代码围栏，格式如下：\n${MEMORY_JSON_SHAPE}`,
      `最近的对话：\n${lines}${knownBlock}\n\n请按要求输出 JSON。`,
      0.3,
      '记忆蒸馏',
    );
  } catch {
    return [];
  }
  return coerceStringArray(raw.memories)
    .map((m) => m.slice(0, 60))
    .filter(Boolean)
    .slice(0, 5);
}

/**
 * 用 chat 模型总结「TA 什么场景爱发语音」。`voiceWindows` 是若干语音前后的对话片段
 * （已转录文本），不够时返回空串、由调用方兜底。
 */
export async function summarizeVoiceScenario(
  endpoint: AgentLabEndpoint,
  friendName: string,
  voiceWindows: string[],
): Promise<string> {
  const windows = voiceWindows.filter((w) => w.trim()).slice(0, 12);
  if (windows.length === 0) return '';
  const text = await chatCompletion(
    endpoint,
    `你在分析「${friendName}」的语音使用习惯。下面是 TA 发语音的若干对话片段（语音内容已转成文字，标注为「[语音]…」）。` +
      '用一句话总结 TA 倾向在什么场景／情绪下发语音（如：内容长、激动、撒娇、懒得打字等）。只输出这句话，不要解释。',
    windows.map((w, i) => `片段${i + 1}：\n${w}`).join('\n\n'),
    0.3,
  );
  return text.trim().slice(0, 120);
}

const STICKER_JSON_SHAPE = `{
  "description": "这张表情图的内容，10-25 字（如：一只柴犬竖大拇指；龇牙咧嘴的猫举着'打钱'牌子）",
  "scenario": "TA 通常在什么语境/情绪下发这张，10-25 字（如：附和赞同时；阴阳怪气催人时）"
}`;

/**
 * 用 vision 模型解读一张自定义表情包：内容 + 使用场景。`contextHint` 给一点 TA 发这张时
 * 的上下文文本帮助判断场景。失败/解析不出时返回空串。
 */
export async function describeSticker(
  endpoint: AgentLabEndpoint,
  friendName: string,
  imageDataUrl: string,
  contextHint: string,
): Promise<{ description: string; scenario: string }> {
  const hint = contextHint.trim()
    ? `\n\nTA 发这张表情时附近的聊天片段（帮你判断使用场景）：\n${contextHint.slice(0, 600)}`
    : '';
  let raw = '';
  try {
    raw = await visionCompletion(
      endpoint,
      `你在分析「${friendName}」常用的一张 QQ 自定义表情包。看图描述表情内容，并据上下文推断 TA 的使用场景。` +
        `只输出一个 JSON 对象，不要任何解释或代码围栏，格式如下：\n${STICKER_JSON_SHAPE}`,
      `请解读这张表情包，按要求输出 JSON。${hint}`,
      imageDataUrl,
      0.4,
    );
    const parsed = extractJson(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      return {
        description: coerceString(parsed.description).slice(0, 60),
        scenario: coerceString(parsed.scenario).slice(0, 60),
      };
    }
  } catch {
    /* vision 失败不阻断克隆，返回空解读 */
  }
  return { description: '', scenario: '' };
}

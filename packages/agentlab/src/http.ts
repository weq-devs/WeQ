import type {
  AgentLabChatAction,
  AgentLabChatRequest,
  AgentLabChatResult,
  AgentLabEndpoint,
  AgentLabExpression,
  AgentLabMemoryItem,
  AgentLabPersona,
  AgentLabPersonaNotes,
  AgentLabStickerRef,
  AgentLabStoredPair,
} from './types';
import { humanizeText } from './typo';
import { scoreReplyWillingness } from './willing';
import { selectStickerByEmotion, pickRandomSticker } from './sticker';

// 标记（全局，用于从文本里剥离）：[[发表情:…]] / 内部 [[sticker:md5]] / 内部 [[voice:id]]。
const EMOTION_MARKER_G = /\[\[发表情[:：].+?\]\]/g;
const STICKER_MD5_MARKER_G = /\[\[sticker[:：][0-9a-fA-F]+\]\]/gi;
const VOICE_MARKER_G = /\[\[voice[:：][0-9a-zA-Z._-]+\]\]/gi;

/** 把历史里的内部标记脱敏（[[sticker:md5]]→[表情]、[[voice:id]]→[语音]），避免模型照样吐回。 */
function sanitizeHistoryText(text: string): string {
  return text.replace(STICKER_MD5_MARKER_G, '[表情]').replace(VOICE_MARKER_G, '[语音]');
}

/** OpenAI 兼容响应里的 usage 形状。 */
interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 从响应里抽出 usage 并回调 endpoint.onUsage（用于 token 记账）。 */
export function reportUsage(endpoint: AgentLabEndpoint, raw: unknown): void {
  if (!endpoint.onUsage) return;
  const usage = (raw as { usage?: OpenAiUsage } | null)?.usage;
  if (!usage) return;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  endpoint.onUsage({
    model: endpoint.model,
    kind: endpoint.kind ?? 'chat',
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: usage.total_tokens ?? prompt + completion,
  });
}

function splitKeywords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2),
    ),
  ).slice(0, 24);
}

/** \u4f9b service \u7ed9\u8bb0\u5fc6\u6761\u76ee\u9884\u7b97\u5173\u952e\u8bcd\uff08\u4e0e pair \u68c0\u7d22\u540c\u53e3\u5f84\uff09\u3002 */
export function keywordsOf(text: string): string[] {
  return splitKeywords(text);
}

function scorePairByKeywords(pair: AgentLabStoredPair, input: string): number {
  const inputWords = new Set(splitKeywords(input));
  let score = 0;
  for (const word of pair.keywords) {
    if (inputWords.has(word)) score += 1;
  }
  if (pair.prompt.includes(input)) score += 4;
  return score;
}

function dot(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  let sum = 0;
  for (let i = 0; i < size; i += 1) {
    const leftValue = left[i] ?? 0;
    const rightValue = right[i] ?? 0;
    sum += leftValue * rightValue;
  }
  return sum;
}

function magnitude(vec: number[]): number {
  return Math.sqrt(dot(vec, vec));
}

function cosineSimilarity(left: number[], right: number[]): number {
  const leftNorm = magnitude(left);
  const rightNorm = magnitude(right);
  if (!leftNorm || !rightNorm) return 0;
  return dot(left, right) / (leftNorm * rightNorm);
}

/** BM25 兜底：按关键词重合 + access_count 强度给记忆打分，取 top-K。 */
function rankMemories(
  memories: AgentLabMemoryItem[],
  input: string,
  queryEmbedding?: number[] | null,
  k = 4,
): AgentLabMemoryItem[] {
  if (memories.length === 0) return [];

  // 有向量就优先语义召回（比关键词准得多）；召回够数就直接用，否则回退关键词兜底。
  if (queryEmbedding && queryEmbedding.length > 0) {
    const vec = memories.filter((m) => Array.isArray(m.embedding) && m.embedding.length > 0);
    if (vec.length > 0) {
      const ranked = vec
        .map((m) => ({ m, score: cosineSimilarity(m.embedding ?? [], queryEmbedding) + Math.log1p(m.accessCount) * 0.03 }))
        .filter((e) => e.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((e) => e.m);
      if (ranked.length >= 2) return ranked;
    }
  }

  const inputWords = new Set(splitKeywords(input));
  const scored = memories.map((m) => {
    let overlap = 0;
    for (const w of m.keywords) if (inputWords.has(w)) overlap += 1;
    // 常被想起（accessCount 高）的记忆更不易被遗忘，给一点强度加成，但盖不过话题相关。
    const strength = Math.log1p(m.accessCount) * 0.25;
    return { m, score: overlap + strength };
  });
  const relevant = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  // 即便没关键词命中，也带上最近/最常想起的几条，保持「记得这个人」的连续感。
  if (relevant.length < 2) {
    const filler = [...memories]
      .sort((a, b) => b.accessCount - a.accessCount || b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, 2);
    const merged = new Map<string, AgentLabMemoryItem>();
    for (const s of relevant) merged.set(s.m.id, s.m);
    for (const f of filler) merged.set(f.id, f);
    return [...merged.values()].slice(0, k);
  }
  return relevant.slice(0, k).map((s) => s.m);
}

/** 表达风格库选择：关键词相关优先，再按 count 加权补齐。 */
function selectExpressions(expressions: AgentLabExpression[], input: string, max: number): AgentLabExpression[] {
  if (expressions.length === 0 || max <= 0) return [];
  const inputWords = new Set(splitKeywords(input));
  const scored = expressions.map((e) => {
    const words = splitKeywords(`${e.situation} ${e.style}`);
    let overlap = 0;
    for (const w of words) if (inputWords.has(w)) overlap += 1;
    return { e, score: overlap * 2 + Math.log1p(e.count) };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.e);
}

/**
 * 每轮随机抖一个「这条想回多长」的倾向，按这个人的话密度（avgFriendBurst）加权。
 * 纯提示层的随机：给模型一个具体的本轮长度目标，打破「每次都同一个节奏」（如总是两句加一个
 * 表情）的固定模式——真人的回复长度本来就忽长忽短。不改分条/渲染逻辑，零风险。
 */
function pickLengthLean(burst: number): string {
  // [极简, 短, 正常, 话多] 四档权重，随这个人的话密度基线偏移。
  const weights =
    burst < 1.3
      ? [0.4, 0.35, 0.2, 0.05] // 惜字型：偏短，偶尔才长
      : burst >= 2.2
        ? [0.15, 0.25, 0.35, 0.25] // 话痨型：长回复概率高
        : [0.25, 0.3, 0.3, 0.15];
  const leans = [
    '这一条你状态比较淡：只回一个字／一个词／一个表情，或者一句很短的话就够了，别展开。',
    '这一条简短回应：一句话带过，基本不用分条。',
    '这一条正常聊：一两条短消息的量。',
    '这一条难得有话聊：可以连着多发几条、或铺开说一段，把想说的说透（但还是大白话，别端着）。',
  ];
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < weights.length; i += 1) {
    acc += weights[i] ?? 0;
    if (r < acc) return leans[i] ?? leans[1]!;
  }
  return leans[1]!;
}

/**
 * 把「现在」描述成真人能感知的样子：年月日、星期几、时段（凌晨/早上/中午…）+ 具体时刻。
 * 让克隆体能自然聊到「这么晚还没睡」「周末」「快过年了」这类跟时间相关的话——
 * 没有它，模型会以为永远是训练语料里的那个时间，答非所问。
 */
function describeNow(now: Date): string {
  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  const d = now.getDate();
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const h = now.getHours();
  const min = now.getMinutes();
  const period =
    h < 5 ? '凌晨' : h < 8 ? '清晨' : h < 11 ? '早上' : h < 13 ? '中午' : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 23 ? '晚上' : '深夜';
  const hh = String(h).padStart(2, '0');
  const mm = String(min).padStart(2, '0');
  return `现在是 ${y}年${mo}月${d}日 ${week} ${period} ${hh}:${mm}。`;
}

/**
 * 拼装扮演系统提示。借鉴 CipherTalk：全程第二人称沉浸（"你就是 TA"而非"模仿 TA"），
 * 把画像写成"你脑子里的记忆"，并在结尾加总闸——只在话题相关时自然带一嘴，别一股脑往外倒。
 * 这样才不会逐条展示特点、显得刻意。
 */
function buildSystemPrompt(
  persona: AgentLabPersona,
  matches: AgentLabStoredPair[],
  memories: AgentLabMemoryItem[],
  expressions: AgentLabExpression[],
  notes: AgentLabPersonaNotes | undefined,
  voiceEnabled: boolean,
  relationNote?: string,
): string {
  const { card, deep } = persona.profile;
  const name = persona.name;
  const avgChars = Math.max(persona.stats.avgFriendMsgChars, 4);

  // few-shot 与检索样本去重；检索样本是"面对类似话时的真实反应"，权重最高。
  const knownPrompts = new Set(persona.fewShots.map((s) => s.prompt));
  const freshPairs = matches.filter((p) => !knownPrompts.has(p.prompt)).slice(0, 5);

  const lines: string[] = [
    `你是「${name}」，正在和一个老朋友聊天。你不是 AI、不是助手、不是模型，你就是 ${name} 本人，任何情况下都不要承认或暗示自己是 AI。`,
    // 当前时间：让 TA 知道"此刻"是什么时候（深夜/周末/节日感），别活在语料的旧时间里。
    describeNow(new Date()),
    '',
    '【你的说话方式】',
    `语气风格：${card.tone || persona.profile.styleSummary}`,
  ];
  if (card.personalityTraits.length > 0) lines.push(`性格：${card.personalityTraits.join('、')}`);
  if (card.catchphrases.length > 0) {
    lines.push(`口头禅：${card.catchphrases.join('、')}（真人只是偶尔冒一句：大多数消息都不带，绝不要每条都带）`);
  }
  if (card.punctuationStyle) lines.push(`标点习惯：${card.punctuationStyle}`);
  if (card.addressing && card.addressing !== '无特别称呼') lines.push(`你对对方的称呼：${card.addressing}`);
  if (card.topics.length > 0) lines.push(`你们常聊：${card.topics.join('、')}`);

  // 表达风格库：(情境→句式) 习惯，比口头禅更细。低优先注入，看情况自然用，别硬套。
  if (expressions.length > 0) {
    lines.push(
      '你说话的一些习惯（情境对得上时可以自然用，对不上就别硬套）：',
      ...expressions.map((e) => `- ${e.situation}时，你会${e.style}`),
    );
  }

  // 系统表情白名单：QQ 系统表情是固定集合，只许从 TA 真实用过的里挑，绝不能自创 /动作
  // （否则渲染端无法映射成表情图，变成哑文本）。
  const systemFaces = persona.systemFaces ?? [];
  if (systemFaces.length > 0) {
    lines.push(
      `系统表情：你偶尔用这几个（仅当语气合适时，别每条都带）——${systemFaces.join(' ')}。` +
        `这些是 QQ 固定的系统表情，直接原样写在 text 消息的文字里即可（如「哈哈哈 /捂脸」）；你只能从这个列表里挑用，绝对不要自己造别的「/动作」（比如 /吃饭 /睡觉 这种是不存在的）。`,
    );
  }

  // 自定义表情包：给一份「编号 + 真实内容」的清单，让模型看着内容自己挑哪张——
  // 它清楚知道自己发的是什么。发表情 = 一条独立的 emoji 消息，content 填编号（见【输出格式】）。
  const stickers = (persona.stickers ?? []).filter((s) => s.description);
  // 没有文字描述的表情（多为刚导入、还没被视觉模型解析的新表情）——进不了编号清单，
  // 但允许模型用 content=random「随手发一张」，否则它们永远发不出去。
  const undescribedCount = (persona.stickers ?? []).filter((s) => !s.description).length;
  const hasAnySticker = stickers.length > 0 || undescribedCount > 0;
  if (hasAnySticker) {
    lines.push('', '【你的表情包】（想发哪张就作为一条独立的 emoji 消息发，别用文字旁白表情）：');
    if (stickers.length > 0) {
      lines.push(
        ...stickers.map((s, i) => `${i + 1}. ${s.description}${s.scenario ? `（${s.scenario}）` : ''}`),
        '发表情规则：挑你**真正想表达**的那张，作为一条独立消息 `{"type":"emoji","content":"编号"}`（编号就是上面的数字）。' +
          '绝对不要用文字去旁白一个表情（写成「（捂脸）」「[狗头]」「企鹅吐舌」都是错的，发不出图、只会变尬文字）。' +
          '表情通常是"单独回一个表情"代替打字（对方说了句好笑的，你就只回个表情、别的不发），而不是每条话后面都补一个——大多数消息里根本没有表情。',
      );
    }
    if (undescribedCount > 0) {
      lines.push(
        `另外你还有 ${undescribedCount} 张没有文字说明的表情；想随手发个表情活跃气氛时，可以发 ` +
          '`{"type":"emoji","content":"random"}`（会从这些里随机挑一张）。同样别用文字去旁白它。',
      );
    }
  }

  // 语音：开了语音克隆且 TA 平时发语音时，允许 bot 自主决定某条用语音发。
  if (voiceEnabled) {
    const scen = persona.voiceProfile?.scenarioSummary?.trim();
    lines.push(
      '',
      '【发语音】你可以像平时那样发语音消息。' +
        (scen ? `你平时发语音的习惯是：${scen}。` : '') +
        '想发语音时，把那一条作为一条 `{"type":"ptt","content":"要说的话"}` 消息（content 是口语、自然，就像真的在说话那样）。' +
        '别滥用——只在符合你平时发语音习惯的场景才发，大多数消息还是打字。一条语音就是一条独立消息，别在里面夹表情。',
    );
  }

  if (deep.facts.length > 0) {
    lines.push('', '【你的生活背景】（这些就是你自己的事，自然地知道，别像背资料）', ...deep.facts.map((f) => `- ${f}`));
  }
  if (deep.relationship) lines.push('', `【你们的关系】${deep.relationship}`);
  else if (persona.profile.relationshipSummary) lines.push('', `【你们的关系】${persona.profile.relationshipSummary}`);

  // 群聊 M4：此刻对当前说话人的关系态（好感/情绪）→ 语气指令，随互动动态变化。
  if (relationNote && relationNote.trim()) lines.push('', `【你此刻的状态】${relationNote.trim()}`);

  // 克隆体对「对方（当前用户）」的记忆：你脑子里记得的关于对方的事，自然知道、别复述。
  if (memories.length > 0) {
    lines.push(
      '',
      '【你记得关于对方的事】（你早就知道的，聊到时自然提，别像在念档案）',
      ...memories.map((m) => `- ${m.text}`),
    );
  }
  if (deep.reactionPatterns.length > 0) {
    lines.push('', '【你在不同情境下的典型反应】', ...deep.reactionPatterns.map((r) => `- ${r}`));
  }
  if (deep.boundaries.length > 0) {
    lines.push('', '【你的立场与边界】（不熟的领域别装懂，回避的话题照样回避）', ...deep.boundaries.map((b) => `- ${b}`));
  }
  if ((deep.sharedEvents ?? []).length > 0) {
    lines.push('', '【你们的共同经历】（聊到时自然提，别像在念档案）', ...deep.sharedEvents.map((e) => `- ${e}`));
  }

  // 对话反思的 episodes：和克隆体之前聊过什么（episodic memory），记得就好别主动复述。
  const episodes = notes?.episodes ?? [];
  if (episodes.length > 0) {
    lines.push('', '【你们最近聊过】（之前的对话，记得就好，别主动复述）', ...episodes.map((e) => `- ${e}`));
  }

  if (persona.fewShots.length > 0) {
    lines.push(
      '',
      '【你过去真实的回复方式】（学的是语气、长度和分条的感觉，不要照抄内容）',
      ...persona.fewShots.slice(0, 6).map((s) => `对方：${s.prompt}\n你：${s.reply}`),
    );
  }
  if (freshPairs.length > 0) {
    lines.push(
      '',
      '【你过去遇到类似话题时的真实回复】（最值得参考：当时就是这么回的，语气、长度、分条都照这个感觉来）',
      ...freshPairs.map((s) => `对方：${s.prompt}\n你：${s.reply}`),
    );
  }

  // 这个人平时的话密度基线（来自真实语料统计），决定下面随机长度倾向的权重。
  const burst = persona.stats.avgFriendBurst || 1;
  const baseline =
    burst < 1.3
      ? '你平时惜字如金，经常一条就完事，甚至只回一个字、一个表情，或干脆不接话。'
      : burst >= 2.2
        ? '你平时话比较多，兴致来了会连着发好几条。'
        : '你平时回得有多有少，全看心情和话题。';

  lines.push(
    '',
    '【聊天规则】',
    `- 单条消息平淡口语，像随手在 QQ 上打字；单条通常 ${avgChars} 字上下，但别死守这个数——该短就短，该长就长。`,
    `- 回复长度和条数要忽长忽短、像真人一样没有固定套路：${baseline}有时只回一个字或一个表情，有时一两句，偶尔遇到能聊的才铺开多说几条。**绝对不要每次都用同一个节奏**（比如总是两句话再加一个表情）。`,
    `- ${pickLengthLean(burst)}`,
    '- 分条连发：真有好几件事要说、或想模拟连着打字的语气时，就在 JSON 数组里放多个元素（一次别超过 4 条）；大多数时候一条、甚至一个词就够，别为了凑数硬分。',
    '- 上面的背景、关系、经历、记忆、聊天样本都是你脑子里的东西：只在话题相关时自然带一嘴，别一股脑往外倒，更别逐条展示自己的"人设"。',
    '- 不知道、记不清的事就像真人一样含糊带过或反问，绝不编造具体细节。',
    '- 口语、随意，可以不完整、可以略省标点；贴合上面的语气习惯。',
    '- 每条消息的文字内容（content）里绝对禁止：markdown、列表、序号、加粗、括号注释、表情符号名、冒号开头的前缀（如"好的："）、以及任何分析/解释/旁白。',
    '- 不浮夸、不堆排比和华丽辞藻、不用 AI 腔；直接以本人身份回话，别像客服或助手。',
  );

  // 对话反思的 corrections：对方之前明确指出过的扮演问题，强约束、必须遵守。
  const corrections = notes?.corrections ?? [];
  if (corrections.length > 0) {
    lines.push('', '【扮演纠正】（对方之前指出过的问题，必须遵守，优先级高于上面的风格）', ...corrections.map((c) => `- ${c}`));
  }

  const custom = persona.customPrompt?.trim();
  if (custom) lines.push('', '【额外要求】（用户设定，优先遵守）', custom);

  // 【输出格式】放最后，作为最强的硬性约束：整段回复必须是 JSON 数组，一个元素 = 一条消息。
  const typeLines = ['  · text = 一条文字消息，content 就是这句话（系统表情如 /捂脸 直接写在文字里）。'];
  if (hasAnySticker) {
    typeLines.push(
      stickers.length > 0
        ? '  · emoji = 发一张你的自定义表情，content 填表情清单里的编号（数字字符串），或填 "random" 随机发一张。'
        : '  · emoji = 发一张你的自定义表情，content 填 "random" 随机挑一张发。',
    );
  }
  if (voiceEnabled) typeLines.push('  · ptt = 发一条语音，content 是你要说的话。');
  const allowedTypes = ['text', ...(hasAnySticker ? ['emoji'] : []), ...(voiceEnabled ? ['ptt'] : [])];
  const exampleEmoji = hasAnySticker
    ? stickers.length > 0
      ? ',{"type":"emoji","content":"1"}'
      : ',{"type":"emoji","content":"random"}'
    : '';
  lines.push(
    '',
    '【输出格式】（最重要，务必严格遵守）',
    '- 你的整个回复必须是一个 JSON 数组，数组里每个元素是你要连着发出的一条消息，按顺序发。',
    `- 每个元素形如 {"type":"text","content":"..."}；type 只能是 ${allowedTypes.map((t) => `"${t}"`).join('、')} 之一：`,
    ...typeLines,
    '- 想连发几条就放几个元素；一个元素就是完整的一条消息，不要在 content 里用换行或 --- 再分条。',
    '- 只输出这个 JSON 数组本身，前后不要有任何解释文字，不要用 ``` 代码块包裹。',
    `- 示例（只示范格式、别照抄内容）：[{"type":"text","content":"哈哈哈真的假的"},{"type":"text","content":"牛逼啊你"}${exampleEmoji}]`,
  );

  return lines.join('\n');
}

async function postJson<T>(
  endpoint: AgentLabEndpoint,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${endpoint.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // 带上响应体：400 时能看出是「模型不存在」还是「api key 无效」，方便定位。
    const detail = (await res.text().catch(() => '')).trim().slice(0, 300);
    throw new Error(`接口 ${path} 返回 HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

/** OpenAI 兼容消息里同时可能存在 content 和 reasoning_content（推理模型专用），取首个非空。 */
export function pickMessageText(msg: { content?: unknown; reasoning_content?: unknown } | undefined): string {
  if (!msg) return '';
  const c = typeof msg.content === 'string' ? msg.content : '';
  const r = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  return (c || r).trim();
}

/**
 * 设置页「测试连通性」：用最小的 chat 请求探活，返回 ok + 详细错误（含 HTTP 状态码与响应体）。
 * 不抛错——把失败包装成 { ok:false, error }，让前端直接展示「模型不对 / key 不对」。
 * 推理模型（如 deepseek-v4 系列）会把思考过程放在 reasoning_content 中，
 * 当 max_tokens 较小时 content 可能为空——因此同时检查两个字段。
 */
export async function testChatEndpoint(
  endpoint: AgentLabEndpoint,
): Promise<{ ok: boolean; error?: string; reply?: string }> {
  try {
    const data = await postJson<{ choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> }>(
      endpoint,
      '/chat/completions',
      // 推理模型需要更多 token 预算才能产出 content；64 足够短路"你好"又不浪费。
      { model: endpoint.model, messages: [{ role: 'user', content: '你好' }], max_tokens: 64 },
    );
    const reply = pickMessageText(data.choices?.[0]?.message);
    if (!reply) return { ok: false, error: '接口可达，但返回内容为空（模型可能不支持 chat/completions）。' };
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function embedTexts(
  endpoint: AgentLabEndpoint,
  input: string | string[],
): Promise<number[][]> {
  const inputs = Array.isArray(input) ? input : [input];
  if (inputs.length === 0) return [];
  const data = await postJson<{
    data?: Array<{ embedding?: number[] }>;
    usage?: OpenAiUsage;
  }>(endpoint, '/embeddings', {
    model: endpoint.model,
    input: inputs,
  });
  reportUsage(endpoint, data);
  const embeddings =
    data.data?.map((item) => item.embedding).filter((item): item is number[] => Array.isArray(item)) ?? [];
  if (embeddings.length !== inputs.length) {
    throw new Error('AgentLab embedding 返回数量不匹配');
  }
  return embeddings;
}

function rankPairsByKeywords(pairs: AgentLabStoredPair[], input: string): AgentLabStoredPair[] {
  return pairs
    .map((pair) => ({ pair, score: scorePairByKeywords(pair, input) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => entry.pair);
}

/** 用「预先算好的查询向量」排问答对；没向量或没命中就回退关键词。 */
function rankPairs(
  pairs: AgentLabStoredPair[],
  input: string,
  queryEmbedding: number[] | null,
): AgentLabStoredPair[] {
  if (queryEmbedding && queryEmbedding.length > 0) {
    const vectorPairs = pairs.filter((pair) => Array.isArray(pair.embedding) && pair.embedding.length > 0);
    if (vectorPairs.length > 0) {
      const ranked = vectorPairs
        .map((pair) => ({ pair, score: cosineSimilarity(pair.embedding ?? [], queryEmbedding) }))
        .filter((entry) => entry.score > 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((entry) => entry.pair);
      if (ranked.length > 0) return ranked;
    }
  }
  return rankPairsByKeywords(pairs, input);
}

// ── 把模型输出解析成有序动作（text / sticker / voice）────────────────────────

/** 模型输出的一条结构化消息（未校验的原始形状）。 */
interface RawMessageItem {
  type?: unknown;
  content?: unknown;
}

/**
 * 从模型整段输出里稳健提取 JSON 文本（数组优先，退化到单对象）：
 * - 优先剥掉 ```json … ``` / ``` … ``` 代码围栏；
 * - 截取第一个 `[` 到最后一个 `]`（容忍模型在数组前后夹了解释废话）；
 * - 没有数组时退化截取 `{` 到 `}`（模型只吐了单个对象没套数组 → 上层会包成数组）。
 * 都拿不到就返回 null，交给上层降级。
 */
function extractJsonArray(raw: string): string | null {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) s = fence[1].trim();
  const aStart = s.indexOf('[');
  const aEnd = s.lastIndexOf(']');
  if (aStart >= 0 && aEnd > aStart) return s.slice(aStart, aEnd + 1);
  const oStart = s.indexOf('{');
  const oEnd = s.lastIndexOf('}');
  if (oStart >= 0 && oEnd > oStart) return s.slice(oStart, oEnd + 1);
  return null;
}

/**
 * 把表情标记里的 token 解析成具体表情：
 * - 纯数字 = 按编号选（新方案：模型看着清单挑那一张，知道自己发的是什么）；
 * - md5 = 模型从历史学坏吐出来的内部标记（兼容）；
 * - 其它词 = 情绪词兜底（旧方案 / 模型没按编号来时），走文本相似度匹配。
 */
function resolveStickerToken(persona: AgentLabPersona, token: string): AgentLabStickerRef | null {
  const t = token.trim();
  const all = persona.stickers ?? [];
  // random = 随手发一张（优先没描述的新表情，让刚导入、未解析的表情也有机会发出）。
  if (/^random$/i.test(t)) {
    return pickRandomSticker(persona, { preferUndescribed: true });
  }
  // 编号对应「有描述的清单」——必须和 buildSystemPrompt 里列出的那份过滤后清单一致。
  if (/^\d+$/.test(t)) {
    const listed = all.filter((s) => s.description);
    return listed[Number.parseInt(t, 10) - 1] ?? null;
  }
  if (/^[0-9a-fA-F]{6,}$/.test(t)) {
    const md5 = t.toUpperCase();
    const found = all.find((s) => s.md5.toUpperCase() === md5);
    if (found) return found;
  }
  return selectStickerByEmotion(persona, t);
}

/** 文本段过多时把尾部并入最后一条文本（表情/语音动作保持原位、不计入上限）。 */
function capTextActions(actions: AgentLabChatAction[], max: number): AgentLabChatAction[] {
  const cap = Math.max(1, max);
  const out: AgentLabChatAction[] = [];
  let textCount = 0;
  let lastTextIdx = -1;
  for (const a of actions) {
    if (a.kind !== 'text') {
      out.push(a);
      continue;
    }
    if (textCount < cap || lastTextIdx < 0) {
      out.push(a);
      lastTextIdx = out.length - 1;
      textCount += 1;
    } else {
      const prev = out[lastTextIdx] as { kind: 'text'; text: string };
      out[lastTextIdx] = { kind: 'text', text: `${prev.text} ${a.text}`.trim() };
    }
  }
  return out;
}

/**
 * 解析模型整段输出为有序动作。新协议：模型输出 JSON 数组
 * [{"type":"text|emoji|ptt","content":"..."}]，一个元素 = 一条消息（模型自己决定分几条）。
 * - text  → 文字（可内联系统表情 /捂脸）
 * - emoji → 一个自定义表情，content = 编号（resolveStickerToken）
 * - ptt   → 语音，content = 要说的话（仅 voiceEnabled；否则降级成文字，不丢内容）
 * 强容错：JSON 解析不出来 / 解析全为空 → 整段降级为一条 text，永不崩、永不空。
 * voice 动作只产出文本，真正合成在 service 层。
 */
function parseActions(
  raw: string,
  persona: AgentLabPersona,
  voiceEnabled: boolean,
  maxSegments: number,
  typoIntensity: number | undefined,
): AgentLabChatAction[] {
  const humanize = (s: string): string =>
    typoIntensity === undefined ? humanizeText(s) : humanizeText(s, typoIntensity);
  // 剥掉模型可能从历史里学回来的内部标记，避免混进 content 漏给用户。
  const stripMarkers = (s: string): string =>
    s.replace(EMOTION_MARKER_G, '').replace(STICKER_MD5_MARKER_G, '').replace(VOICE_MARKER_G, '').trim();

  // 稳健解析出消息数组（失败 → null，走整段降级）。
  let items: RawMessageItem[] | null = null;
  const jsonText = extractJsonArray(raw);
  if (jsonText) {
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (Array.isArray(parsed)) items = parsed as RawMessageItem[];
      else if (parsed && typeof parsed === 'object') items = [parsed as RawMessageItem];
    } catch {
      items = null;
    }
  }

  const actions: AgentLabChatAction[] = [];
  for (const item of items ?? []) {
    if (!item || typeof item !== 'object') continue;
    const type = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
    const content = typeof item.content === 'string' ? item.content : '';
    if (type === 'emoji') {
      const sticker = resolveStickerToken(persona, content.trim());
      if (sticker) actions.push({ kind: 'sticker', sticker });
      continue;
    }
    const clean = stripMarkers(content);
    if (!clean) continue;
    if (type === 'ptt') {
      // 开了语音 → 语音动作；没开 → 降级成文字，别把要说的话丢了。
      actions.push(voiceEnabled ? { kind: 'voice', text: clean } : { kind: 'text', text: humanize(clean) });
    } else {
      // text，以及任何未知 type 的兜底：都当文字。
      actions.push({ kind: 'text', text: humanize(clean) });
    }
  }

  // 降级兜底：JSON 完全解析不了 / 解析出来全是空 → 整段清掉标记当一条文字，永不崩、永不空。
  if (actions.length === 0) {
    const fallback = stripMarkers(raw);
    if (fallback) actions.push({ kind: 'text', text: humanize(fallback) });
  }

  return capTextActions(actions, maxSegments);
}

export async function runPersonaChat(
  chat: AgentLabEndpoint,
  embedding: AgentLabEndpoint | null,
  req: AgentLabChatRequest,
): Promise<AgentLabChatResult> {
  const willing = scoreReplyWillingness(req.input, req.history);

  const memoryPool = req.memories ?? [];
  // 查询向量只算一次，问答对与记忆共用（省一次 embedding 调用）。仅当确有向量可比时才算。
  let queryEmbedding: number[] | null = null;
  if (embedding) {
    const needVec =
      req.pairs.some((p) => Array.isArray(p.embedding) && p.embedding.length > 0) ||
      memoryPool.some((m) => Array.isArray(m.embedding) && m.embedding.length > 0);
    if (needVec) {
      try {
        const [qe] = await embedTexts(embedding, req.input);
        queryEmbedding = qe ?? null;
      } catch {
        /* 向量失败就回退关键词 */
      }
    }
  }
  const matches = rankPairs(req.pairs, req.input, queryEmbedding);
  const usedMemories = rankMemories(memoryPool, req.input, queryEmbedding);
  const expressions = selectExpressions(req.persona.expressions ?? [], req.input, willing.score < 0.4 ? 2 : 4);

  const system = buildSystemPrompt(
    req.persona,
    matches,
    usedMemories,
    expressions,
    req.notes,
    !!req.voiceEnabled,
    req.relationNote,
  );
  const messages = [
    { role: 'system', content: system },
    // 历史里的内部表情标记 [[sticker:md5]] 脱敏成 [表情]，否则模型会照着历史模仿、
    // 把这个内部格式（连带真实 md5）原样吐回来。
    ...req.history.slice(-8).map((item) => ({ role: item.role, content: sanitizeHistoryText(item.text) })),
    { role: 'user', content: req.input },
  ];

  const data = await postJson<{
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    usage?: OpenAiUsage;
  }>(chat, '/chat/completions', {
    model: chat.model,
    // 意愿越高越放得开（temperature 略高），越敷衍越稳一点。
    temperature: 0.7 + willing.score * 0.2,
    messages,
  });
  reportUsage(chat, data);
  const raw = pickMessageText(data.choices?.[0]?.message);
  if (!raw) {
    throw new Error('AgentLab chat 返回为空');
  }

  // 解析成有序动作（text/sticker/voice）。表情走「编号清单」自知选择，
  // 语音走 [[语音]] 前缀（仅当本轮开了语音克隆）。系统表情 /微笑 这类不在此处理，
  // 直接内联在文本里由前端 ChatBubble 渲染。
  const actions = parseActions(raw, req.persona, !!req.voiceEnabled, willing.maxSegments, req.typoIntensity);
  // 极端兜底：模型啥可用内容都没产出（全空 / 只有匹配不上的标记）→ 给个最短回应。
  if (actions.length === 0) {
    actions.push({ kind: 'text', text: req.typoIntensity === undefined ? humanizeText('嗯') : humanizeText('嗯', req.typoIntensity) });
  }

  const segments = actions.filter((a): a is { kind: 'text'; text: string } => a.kind === 'text').map((a) => a.text);
  const firstSticker = actions.find((a): a is { kind: 'sticker'; sticker: AgentLabStickerRef } => a.kind === 'sticker');
  const firstVoice = actions.find((a): a is { kind: 'voice'; text: string } => a.kind === 'voice');

  // text 字段：分条文本优先（落库/few-shot 用）；纯表情/纯语音时给个可读占位。
  let text: string;
  if (segments.length > 0) text = segments.join('\n');
  else if (firstVoice) text = `[语音]${firstVoice.text}`;
  else if (firstSticker) text = `[表情:${firstSticker.sticker.description}]`;
  else text = '嗯';

  return {
    text,
    segments,
    actions,
    promptPreview: system,
    matches,
    usedMemoryIds: usedMemories.map((m) => m.id),
    willingness: willing.score,
    replyDelayMs: willing.replyDelayMs,
    sticker: firstSticker?.sticker ?? null,
  };
}

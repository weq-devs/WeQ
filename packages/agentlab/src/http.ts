import type {
  AgentLabChatRequest,
  AgentLabChatResult,
  AgentLabEndpoint,
  AgentLabPersona,
  AgentLabStoredPair,
} from './types';

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

/**
 * 拼装扮演系统提示。借鉴 CipherTalk：全程第二人称沉浸（"你就是 TA"而非"模仿 TA"），
 * 把画像写成"你脑子里的记忆"，并在结尾加总闸——只在话题相关时自然带一嘴，别一股脑往外倒。
 * 这样才不会逐条展示特点、显得刻意。
 */
function buildSystemPrompt(persona: AgentLabPersona, matches: AgentLabStoredPair[]): string {
  const { card, deep } = persona.profile;
  const name = persona.name;
  const avgChars = Math.max(persona.stats.avgFriendMsgChars, 4);

  // few-shot 与检索样本去重；检索样本是"面对类似话时的真实反应"，权重最高。
  const knownPrompts = new Set(persona.fewShots.map((s) => s.prompt));
  const freshPairs = matches.filter((p) => !knownPrompts.has(p.prompt)).slice(0, 5);

  const lines: string[] = [
    `你是「${name}」，正在和一个老朋友聊天。你不是 AI、不是助手、不是模型，你就是 ${name} 本人，任何情况下都不要承认或暗示自己是 AI。`,
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

  // 系统表情白名单：QQ 系统表情是固定集合，只许从 TA 真实用过的里挑，绝不能自创 /动作
  // （否则渲染端无法映射成表情图，变成哑文本）。
  const systemFaces = persona.systemFaces ?? [];
  if (systemFaces.length > 0) {
    lines.push(
      `系统表情：你偶尔用这几个（仅当语气合适时，别每条都带）——${systemFaces.join(' ')}。` +
        `这些是 QQ 固定的系统表情，你只能从这个列表里原样挑用，绝对不要自己造别的「/动作」（比如 /吃饭 /睡觉 这种是不存在的）。`,
    );
  }

  // 自定义表情包：只在这里告诉它 TA 有哪些爱用的表情及其使用场景（当前不发图，只塑造风格感）。
  const stickers = (persona.stickers ?? []).filter((s) => s.description);
  if (stickers.length > 0) {
    lines.push(
      `你有几张爱用的自定义表情包：${stickers
        .map((s) => `「${s.description}」(${s.scenario || '随手发'})`)
        .join('；')}。聊到对味的场景时，可以用一句话把这种感觉表达出来。`,
    );
  }

  if (deep.facts.length > 0) {
    lines.push('', '【你的生活背景】（这些就是你自己的事，自然地知道，别像背资料）', ...deep.facts.map((f) => `- ${f}`));
  }
  if (deep.relationship) lines.push('', `【你们的关系】${deep.relationship}`);
  else if (persona.profile.relationshipSummary) lines.push('', `【你们的关系】${persona.profile.relationshipSummary}`);
  if (deep.reactionPatterns.length > 0) {
    lines.push('', '【你在不同情境下的典型反应】', ...deep.reactionPatterns.map((r) => `- ${r}`));
  }
  if (deep.boundaries.length > 0) {
    lines.push('', '【你的立场与边界】（不熟的领域别装懂，回避的话题照样回避）', ...deep.boundaries.map((b) => `- ${b}`));
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

  lines.push(
    '',
    '【聊天规则】',
    `- 短消息风格：单条 ${avgChars} 字左右；超过两句话通常拆成 2-4 条短回复，像真人一句一句发；简单的话一条就够。`,
    '- 上面的背景、关系、经历、聊天样本都是你脑子里的记忆：只在话题相关时自然带一嘴，别一股脑往外倒，更别逐条展示自己的"人设"。',
    '- 不知道、记不清的事就像真人一样含糊带过或反问，绝不编造具体细节。',
    '- 始终口语化，贴合上面的语气和标点习惯；禁止 markdown、列表、序号等格式符号。',
    '- 不要输出任何分析、解释或旁白，直接以本人身份回话。',
  );

  const custom = persona.customPrompt?.trim();
  if (custom) lines.push('', '【额外要求】（用户设定，优先遵守）', custom);

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
    throw new Error(`AgentLab 接口调用失败: ${path} HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function embedTexts(
  endpoint: AgentLabEndpoint,
  input: string | string[],
): Promise<number[][]> {
  const inputs = Array.isArray(input) ? input : [input];
  if (inputs.length === 0) return [];
  const data = await postJson<{
    data?: Array<{ embedding?: number[] }>;
  }>(endpoint, '/embeddings', {
    model: endpoint.model,
    input: inputs,
  });
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

async function rankPairs(
  embedding: AgentLabEndpoint | null,
  pairs: AgentLabStoredPair[],
  input: string,
): Promise<AgentLabStoredPair[]> {
  const vectorPairs = pairs.filter((pair) => Array.isArray(pair.embedding) && pair.embedding.length > 0);
  if (!embedding || vectorPairs.length === 0) {
    return rankPairsByKeywords(pairs, input);
  }

  try {
    const [queryEmbedding] = await embedTexts(embedding, input);
    if (!queryEmbedding) return rankPairsByKeywords(pairs, input);
    const ranked = vectorPairs
      .map((pair) => ({
        pair,
        score: cosineSimilarity(pair.embedding ?? [], queryEmbedding),
      }))
      .filter((entry) => entry.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((entry) => entry.pair);
    return ranked.length > 0 ? ranked : rankPairsByKeywords(pairs, input);
  } catch {
    return rankPairsByKeywords(pairs, input);
  }
}

export async function runPersonaChat(
  chat: AgentLabEndpoint,
  embedding: AgentLabEndpoint | null,
  req: AgentLabChatRequest,
): Promise<AgentLabChatResult> {
  const matches = await rankPairs(embedding, req.pairs, req.input);
  const system = buildSystemPrompt(req.persona, matches);
  const messages = [
    { role: 'system', content: system },
    ...req.history.slice(-8).map((item) => ({ role: item.role, content: item.text })),
    { role: 'user', content: req.input },
  ];

  const data = await postJson<{
    choices?: Array<{ message?: { content?: string } }>;
  }>(chat, '/chat/completions', {
    model: chat.model,
    temperature: 0.85,
    messages,
  });
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error('AgentLab chat 返回为空');
  }
  return { text, promptPreview: system, matches };
}

/**
 * AI 助手（小Q）消息组装。
 *
 * `ai_assistant_msg_table` 里的一条回复在 40800 中是**多个** MARKDOWN 元素
 * 拼成的流式片段（见 `proto/msg/ai_markdown.ts`）：
 *
 *   reasoning_content → 思考标记（无正文，丢弃）
 *   content 或空阶段  → 正文片段，按顺序拼接
 *   agent_end         → 收尾元数据（摘要 / 权限）
 *
 * 另外还会夹着推荐消息（43）与操作栏（44）元素。本模块把它们折叠成
 * 「一条 markdown + 零到多个交互块」的形状，供渲染层直接使用。
 *
 * 卡片：正文里出现 `[](qagent://markdown/node?type=…&id=…)` 占位符时，
 * 对应的卡片定义在同一个 48707 的 `cardPayload`（JSON）里，按 id 索引。
 * 三种类型：`qui`（结构化卡片，好友推荐 / 授权申请）、`quser`（用户卡）、
 * `qlink`（外链）。
 */

import type { Element, MarkdownElement } from '../../element';

/** ChatType 45 —— QQ AI 助手「小Q」。 */
export const AI_ASSISTANT_CHAT_TYPE = 45;

/** 小Q 主入口在 `ai_session_table` 里的 sessionId。 */
export const AI_ASSISTANT_MAIN_SESSION = '10000';

/** 卡片链接可以带昵称或标题，也可以只有空标签或括号里的 URI。 */
const CARD_URI = /(?:\[((?:\\.|[^\]\\\r\n])*)\])?\(qagent:\/\/markdown\/node\?([^)]*)\)/g;

/** 一张 AI 卡片。`type` 决定渲染方式，`data` 原样保留（各类型结构不同）。 */
export interface AiCard {
  /** 卡片 id（正文占位符里的 `id=`）。 */
  id: string;
  /** `qui` / `quser` / `qlink`，或未识别时原样透传。 */
  type: string;
  /** 原始载荷。 */
  payload: Record<string, unknown>;
}

/** `quser` 卡片的最小身份信息。 */
export interface AiQuserCard {
  peerUid: string;
  peerUin: string;
  peerName: string;
  chatType?: number;
}

/** `qlink` 卡片：一个标题 + 外链。 */
export interface AiQlinkCard {
  title: string;
  url: string;
}

/** 正文按卡片占位符切成的片段。 */
export type AiMarkdownSegment =
  | { kind: 'text'; text: string }
  | { kind: 'card'; card: AiCard; label?: string };

/** 把 `cardPayload` JSON 解析成 id → 卡片的表。解析失败返回空表。 */
export function parseAiCardPayload(json: string | undefined): Map<string, AiCard> {
  const map = new Map<string, AiCard>();
  if (!json) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return map;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    map.set(id, {
      id,
      type: typeof record.type === 'string' ? record.type : 'unknown',
      payload: record,
    });
  }
  return map;
}

/** 推送回复可以省略阶段，仍会携带卡片或推送元数据。 */
function isAiMarkdown(element: Element): element is MarkdownElement {
  if (element.kind !== 'markdown') return false;
  const ai = element.aiMarkdown;
  return Boolean(ai?.phase || ai?.cardPayload || ai?.metaJson);
}

/** 一条 AI 回复折叠后的结果。 */
export interface AiAssistantCollapsed {
  /**
   * 正文 markdown 元素（已拼接所有 content 片段，`aiMarkdown.cardPayload`
   * 汇总了整条回复的卡片定义）。没有正文时返回 null。
   */
  markdown: MarkdownElement | null;
  /** 正文里出现的卡片（按出现顺序去重）。 */
  cards: AiCard[];
  /** 除正文外的其余元素（推荐消息 / 操作栏 / 图片等），保持原顺序。 */
  others: Element[];
  /** `agent_end` 的元数据 JSON（可能含 `auth_denied` / `text_brief`）。 */
  agentEndMeta: string | null;
  /** 整条回复的纯文本摘要（`agent_end` 的 `text_brief`，没有时用拼接正文）。 */
  brief: string;
}

/**
 * 把一条 AI 助手消息的元素折叠成可渲染的形状。
 *
 * 没有 AI 助手 markdown 时原样返回：`markdown` 为 null，
 * `others` 是全部元素。
 */
export function collapseAiAssistantElements(elements: readonly Element[]): AiAssistantCollapsed {
  const aiMarkdowns: MarkdownElement[] = [];
  const others: Element[] = [];
  for (const element of elements) {
    if (isAiMarkdown(element)) aiMarkdowns.push(element);
    else others.push(element);
  }
  if (aiMarkdowns.length === 0) {
    return { markdown: null, cards: [], others: [...elements], agentEndMeta: null, brief: '' };
  }

  let content = '';
  let agentEndMeta: string | null = null;
  let brief = '';
  let base: MarkdownElement | undefined;
  const cardTables: string[] = [];
  for (const element of aiMarkdowns) {
    const ai = element.aiMarkdown!;
    if (ai.cardPayload) cardTables.push(ai.cardPayload);
    if (!ai.phase || ai.phase === 'content') {
      content += element.markdownContent ?? '';
      brief ||= element.markdownTextSummary ?? '';
      base ??= element;
    } else if (ai.phase === 'agent_end') {
      agentEndMeta = ai.metaJson || null;
      const meta = parseJsonObject(agentEndMeta);
      if (typeof meta?.text_brief === 'string') brief = meta.text_brief;
    }
    // reasoning_content 与其它未知 phase：丢弃（实测无正文）。
  }

  // 合并所有片段的卡片表；同一 id 以后出现的为准。
  const cardMap = new Map<string, AiCard>();
  for (const table of cardTables) {
    for (const [id, card] of parseAiCardPayload(table)) cardMap.set(id, card);
  }
  const cards = collectReferencedCards(content, cardMap);

  const merged: MarkdownElement = {
    ...(base ?? aiMarkdowns[0]!),
    markdownContent: content,
    markdownTextSummary: brief || content,
    aiMarkdown: {
      cardPayload: cardTables.length ? JSON.stringify(Object.fromEntries([...cardMap])) : undefined,
      phase: 'content',
      metaJson: agentEndMeta ?? undefined,
    },
  };
  return { markdown: merged, cards, others, agentEndMeta, brief: brief || content };
}

/** 按卡片占位符把正文切成片段，供渲染层逐段绘制。 */
export function splitAiMarkdownSegments(
  text: string,
  cards: readonly AiCard[] | Map<string, AiCard>,
): AiMarkdownSegment[] {
  const map = cards instanceof Map ? cards : new Map(cards.map((card) => [card.id, card]));
  const segments: AiMarkdownSegment[] = [];
  let cursor = 0;
  CARD_URI.lastIndex = 0;
  for (const match of text.matchAll(CARD_URI)) {
    const start = match.index ?? 0;
    const before = text.slice(cursor, start);
    if (before) segments.push({ kind: 'text', text: before });
    const label = match[1];
    const params = new URLSearchParams(match[2]);
    const id = params.get('id') ?? '';
    const card = map.get(id);
    if (card) segments.push({ kind: 'card', card, label });
    else if (label) segments.push({ kind: 'text', text: label });
    cursor = start + match[0].length;
  }
  const tail = text.slice(cursor);
  if (tail) segments.push({ kind: 'text', text: tail });
  return segments;
}

/** 正文里实际引用到的卡片（按出现顺序去重）。 */
function collectReferencedCards(text: string, map: Map<string, AiCard>): AiCard[] {
  const seen = new Set<string>();
  const cards: AiCard[] = [];
  CARD_URI.lastIndex = 0;
  for (const match of text.matchAll(CARD_URI)) {
    const id = new URLSearchParams(match[2]).get('id') ?? '';
    if (seen.has(id)) continue;
    const card = map.get(id);
    if (!card) continue;
    seen.add(id);
    cards.push(card);
  }
  return cards;
}

function parseJsonObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `quser` 卡片的身份字段（结构固定，缺失时给空串）。 */
export function quserCardInfo(card: AiCard): AiQuserCard {
  const data = Array.isArray(card.payload.data) ? card.payload.data[0] : undefined;
  const record = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  return {
    peerUid: typeof record.peerUid === 'string' ? record.peerUid : '',
    peerUin: typeof record.peerUin === 'string' ? record.peerUin : '',
    peerName: typeof record.peerName === 'string' ? record.peerName : '',
    chatType: typeof record.chatType === 'number' ? record.chatType : undefined,
  };
}

/** `qlink` 卡片：取第一条 `{title, url}`。 */
export function qlinkCardInfo(card: AiCard): AiQlinkCard | null {
  const list = card.payload.data;
  if (!Array.isArray(list) || list.length === 0) return null;
  const record = (list[0] && typeof list[0] === 'object' ? list[0] : {}) as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title : '';
  const url = typeof record.url === 'string' ? record.url : '';
  return title || url ? { title, url } : null;
}

/** 一条 AI 助手消息的纯文本（列表预览 / 搜索结果用）。 */
export function aiAssistantPlainText(elements: readonly Element[]): string {
  const { brief } = collapseAiAssistantElements(elements);
  // 去掉卡片占位符，避免把 qagent:// URI 漏进预览。
  return brief
    .replace(CARD_URI, (_, label?: string) => label ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * AiAssistantService — QQ AI 助手「小Q」（chatType 45）只读入口。
 *
 * 数据在两张独立表（`ai_session_table` / `ai_assistant_msg_table`），会话键是
 * sessionId；小Q 主入口固定为 `10000`。完整会话保留全部消息类型，**不支持发送**
 * ——与公众号 / 服务号同一套只读语义。
 *
 * 渲染前先把一条回复的流式 MARKDOWN 片段折叠成「一条 markdown + 交互块」，
 * 卡片（好友推荐 / 授权申请 / 用户卡 / 外链）从 48707 的 `cardPayload` 里取。
 */

import type { AccountSession } from '@weq/account';
import {
  AI_ASSISTANT_MAIN_SESSION,
  collapseAiAssistantElements,
  splitAiMarkdownSegments,
  type AiCard,
  type AiMarkdownSegment,
  type Element,
} from '@weq/codec';
import { toRenderElements, type RenderElement } from './msg_view';

export interface AiAssistantSessionSummary {
  /** 40021 — sessionId；`10000` 是小Q 主入口。 */
  sessionId: string;
  /** 是否小Q 主入口。 */
  isMain: boolean;
  /** 40094 — 会话标题。 */
  title: string;
  /** 40003 — 消息条数。 */
  messageCount: number;
  /** 40050 — 最后一条消息时间（unix 秒）。 */
  sendTime: bigint;
  /** 最后一条消息的纯文本预览（已去掉卡片占位符）。 */
  preview: string;
}

/** 渲染层用的一条 AI 消息。 */
export interface AiAssistantMessage {
  msgId: string;
  msgSeq: string;
  sendTime: string;
  /** 1/2 = 我发的，0 = AI 发的（列 40013）。 */
  mine: boolean;
  senderUid: string;
  /**
   * 正文按卡片链接切好的片段，行内卡片保留 Markdown 标签。
   * 没有正文时为空数组。
   */
  segments: AiMarkdownSegment[];
  /** 正文 markdown 原文（供复制 / 搜索 / 纯文本回退）。 */
  text: string;
  /** 其余元素（推荐消息 / 操作栏 / 图片），按原顺序。 */
  elements: RenderElement[];
  /** 是否带授权申请（agent_end 的 `auth_denied`）。 */
  needsAuth: boolean;
}

export interface AiAssistantConversation {
  sessionId: string;
  title: string;
  messages: AiAssistantMessage[];
}

export class AiAssistantService {
  constructor(private readonly session: AccountSession) {}

  /** 是否有 AI 助手数据（旧版 QQ 无这两张表）。 */
  async available(): Promise<boolean> {
    return this.session.aiAssistant.hasTables();
  }

  /**
   * 全部 AI 会话，最新在前。小Q 主入口（10000）单独标出 —— 它是从会话列表
   * 点进来的那一项，其余是用户新开的子会话。
   */
  async listSessions(): Promise<AiAssistantSessionSummary[]> {
    const sessions = await this.session.aiAssistant.listSessions();
    return sessions.map((session) => {
      const collapsed = collapseAiAssistantElements(session.preview);
      return {
        sessionId: session.sessionId,
        isMain: session.sessionId === AI_ASSISTANT_MAIN_SESSION,
        title:
          session.title ||
          (session.sessionId === AI_ASSISTANT_MAIN_SESSION ? '小Q' : session.sessionId),
        messageCount: session.messageCount,
        sendTime: session.lastTime,
        preview: plainPreview(collapsed.brief, session.preview),
      };
    });
  }

  /** 单个会话的完整消息（AI 会话体量很小，一次读完）。 */
  async listMessages(sessionId: string): Promise<AiAssistantMessage[]> {
    const rows = await this.session.aiAssistant.listMessages(sessionId);
    return rows.map((row) => {
      const collapsed = collapseAiAssistantElements(row.elements);
      const text = collapsed.markdown?.markdownContent ?? '';
      const segments = text
        ? splitAiMarkdownSegments(text, collapsed.cards)
        : cardsAsSegments(collapsed.cards);
      return {
        msgId: String(row.msgId),
        msgSeq: String(row.msgSeq),
        sendTime: String(row.sendTime),
        mine: row.sendType === 1n || row.sendType === 2n,
        senderUid: row.senderUid,
        segments,
        text,
        elements: toRenderElements(collapsed.others),
        needsAuth: agentNeedsAuth(collapsed.agentEndMeta),
      };
    });
  }

  /** 会话列表预览：优先用正文摘要，没有时退回预览元素。 */
  async conversationPreview(sessionId: string): Promise<string> {
    const session = await this.session.aiAssistant.getSession(sessionId);
    if (!session) return '';
    const collapsed = collapseAiAssistantElements(session.preview);
    return plainPreview(collapsed.brief, session.preview);
  }
}

/** 卡片定义表（供调试 / 导出用）。 */
export function aiCardsOf(elements: readonly Element[]): AiCard[] {
  return collapseAiAssistantElements(elements).cards;
}

function plainPreview(brief: string, preview: readonly Element[]): string {
  const text = brief.trim();
  if (text) return text;
  const markdown = preview.find((element) => element.kind === 'markdown');
  if (markdown && markdown.kind === 'markdown') return (markdown.markdownContent ?? '').trim();
  const plain = preview.find((element) => element.kind === 'text');
  return plain && plain.kind === 'text' ? (plain.textContent ?? '').trim() : '';
}

/**
 * 正文为空但带卡片的回复：把卡片本身当片段返回，保证界面上仍能看到卡片。
 * （实测授权申请有时正文只有一句引导语，卡片仍在正文占位符里，走不到这里；
 * 留作兜底。）
 */
function cardsAsSegments(cards: readonly AiCard[]): AiMarkdownSegment[] {
  return cards.map((card) => ({ kind: 'card' as const, card }));
}

/** `agent_end.metaJson` 里的 `auth_denied.need_auth`。 */
function agentNeedsAuth(metaJson: string | null): boolean {
  if (!metaJson) return false;
  try {
    const meta = JSON.parse(metaJson) as { auth_denied?: { need_auth?: boolean } };
    return meta.auth_denied?.need_auth === true;
  } catch {
    return false;
  }
}

/** 供上层（导出 / 搜索）把一条 AI 消息摊成纯文本。 */
export function aiMessagePlainText(message: AiAssistantMessage): string {
  const parts = message.segments.map((segment) =>
    segment.kind === 'text' ? segment.text : segment.label || `[${segment.card.type}卡片]`,
  );
  return parts.join('').trim();
}

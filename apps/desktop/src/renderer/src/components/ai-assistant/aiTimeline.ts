/**
 * AI 助手消息 → ChatPane 时间线。
 *
 * 每条消息都挂上 `aiPayload`，`aiMessageRenderer` 据此渲染；`body` 用纯文本
 * 兜底（复制、搜索、无障碍读屏都靠它）。
 */

import { unixDate } from '@weq/time';
import type { DirectConversation, Message, User } from '../../im-template/template/types';
import type { AiAssistantMessageWire } from '../../../../shared/aiAssistantTypes';

/** 渲染器认领消息时读取的字段名。 */
export const AI_PAYLOAD_KEY = 'aiPayload';

export function aiMessagesToTimeline(
  rows: readonly AiAssistantMessageWire[],
  conversation: DirectConversation,
  user: User,
): Message[] {
  return rows.map((row) => {
    const sender = row.mine ? user : conversation.otherUser;
    const message = {
      id: row.msgId,
      msgId: row.msgId,
      msgSeq: row.msgSeq,
      conversationId: conversation.id,
      body: aiWireText(row),
      senderId: sender.id,
      sender,
      createdAt: Number(row.sendTime) > 0 ? (unixDate(row.sendTime)?.toISOString() ?? '') : '',
      [AI_PAYLOAD_KEY]: {
        segments: row.segments,
        elements: row.elements,
        needsAuth: row.needsAuth,
        sendTimeMs: Number(row.sendTime) > 0 ? Number(row.sendTime) * 1000 : 0,
        msgId: row.msgId,
        mine: row.mine,
      },
    };
    return message as unknown as Message;
  });
}

/**
 * 纯文本：正文片段拼接；用户提问没有 segments，退回普通元素里的文本。
 * 卡片段使用 Markdown 标签，保留候选昵称及链接标题。
 */
export function aiWireText(row: AiAssistantMessageWire): string {
  if (row.segments.length === 0) {
    return row.elements
      .map((element) => {
        const typed = element as { type?: string; data?: Record<string, unknown> };
        if (typed.type === 'text' || typed.type === 'at')
          return String(typed.data?.textContent ?? '');
        return '';
      })
      .join('')
      .trim();
  }
  return row.segments
    .map((segment) => (segment.kind === 'text' ? segment.text : (segment.label ?? '')))
    .join('')
    .trim();
}
